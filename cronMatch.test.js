const test   = require('node:test');
const assert = require('node:assert/strict');

const { parseCron, zonedParts, matchesCron, lastDueWithin } = require('./cronMatch');

const AR = 'America/Argentina/Buenos_Aires';

test('parseCron acepta el subconjunto que genera el panel', () => {
  assert.deepEqual(parseCron('0 6 * * *'),       { hour: 6,  minute: 0,  days: [] });
  assert.deepEqual(parseCron('30 18 * * 1,3,5'), { hour: 18, minute: 30, days: [1, 3, 5] });
  assert.deepEqual(parseCron('59 0 * * 0'),      { hour: 0,  minute: 59, days: [0] });
});

test('parseCron rechaza lo que el panel nunca genera', () => {
  assert.equal(parseCron('*/5 * * * *'), null);  // paso
  assert.equal(parseCron('0 6 1 * *'),   null);  // día del mes
  assert.equal(parseCron('0 6 * 3 *'),   null);  // mes puntual
  assert.equal(parseCron('0 24 * * *'),  null);  // hora fuera de rango
  assert.equal(parseCron('0 6 * * 7'),   null);  // día fuera de rango
  assert.equal(parseCron('0 6 * *'),     null);  // campos de menos
  assert.equal(parseCron(''),            null);
  assert.equal(parseCron(null),          null);
});

// La VM corre en UTC; Argentina es UTC-3 todo el año.
test('zonedParts convierte a hora de planta, no a la del proceso', () => {
  // 2026-03-10T09:00:00Z -> 06:00 en Argentina.
  assert.deepEqual(
    zonedParts(new Date('2026-03-10T09:00:00Z'), AR),
    { hour: 6, minute: 0, dow: 2 },   // martes
  );
});

test('la medianoche da hora 0, no 24', () => {
  // 2026-03-10T03:00:00Z -> 00:00 en Argentina.
  const p = zonedParts(new Date('2026-03-10T03:00:00Z'), AR);
  assert.equal(p.hour, 0);
  assert.equal(p.minute, 0);
});

test('una timezone inválida cae al default en vez de tirar', () => {
  const p = zonedParts(new Date('2026-03-10T09:00:00Z'), 'No/Existe');
  assert.deepEqual(p, { hour: 6, minute: 0, dow: 2 });
});

test('matchesCron dispara solo en el minuto exacto de la planta', () => {
  const at6 = new Date('2026-03-10T09:00:00Z');   // 06:00 AR
  assert.equal(matchesCron('0 6 * * *', at6, AR), true);

  // Un minuto antes y uno después no.
  assert.equal(matchesCron('0 6 * * *', new Date('2026-03-10T08:59:00Z'), AR), false);
  assert.equal(matchesCron('0 6 * * *', new Date('2026-03-10T09:01:00Z'), AR), false);
});

test('sin convertir la zona, las 6 AR caerían en el UTC equivocado', () => {
  // Este es el bug que la conversión evita: 06:00 UTC son las 03:00 en la
  // planta. Si el motor comparara contra su reloj, la bomba arrancaría de
  // madrugada.
  const sixUtc = new Date('2026-03-10T06:00:00Z');
  assert.equal(matchesCron('0 6 * * *', sixUtc, AR), false);
  assert.equal(zonedParts(sixUtc, AR).hour, 3);
});

test('matchesCron respeta la lista de días', () => {
  const martes6 = new Date('2026-03-10T09:00:00Z');   // martes 06:00 AR
  assert.equal(matchesCron('0 6 * * 2', martes6, AR), true);   // martes
  assert.equal(matchesCron('0 6 * * 1', martes6, AR), false);  // lunes
  assert.equal(matchesCron('0 6 * * 1,2,3', martes6, AR), true);
  assert.equal(matchesCron('0 6 * * *', martes6, AR), true);   // todos los días
});

test('matchesCron con expresión inválida nunca dispara', () => {
  assert.equal(matchesCron('*/5 * * * *', new Date(), AR), false);
  assert.equal(matchesCron('', new Date(), AR), false);
});

test('lastDueWithin encuentra la corrida perdida durante una caída', () => {
  // La VM volvió 6:03 AR; la corrida de las 6:00 quedó dentro de la ventana.
  const back = new Date('2026-03-10T09:03:00Z');
  const due  = lastDueWithin('0 6 * * *', back, AR, 15);
  assert.ok(due, 'tendría que encontrar la corrida de las 6:00');
  assert.deepEqual(zonedParts(due, AR), { hour: 6, minute: 0, dow: 2 });
});

test('lastDueWithin no inventa corridas fuera de la ventana', () => {
  // Volvió 6:20, con ventana de 15 min: la de las 6:00 ya quedó vieja.
  const back = new Date('2026-03-10T09:20:00Z');
  assert.equal(lastDueWithin('0 6 * * *', back, AR, 15), null);
});

test('lastDueWithin respeta el día de la semana', () => {
  // Martes, pero la regla es solo lunes.
  const back = new Date('2026-03-10T09:03:00Z');
  assert.equal(lastDueWithin('0 6 * * 1', back, AR, 15), null);
});

test('lastDueWithin con expresión inválida devuelve null', () => {
  assert.equal(lastDueWithin('*/5 * * * *', new Date(), AR, 15), null);
});
