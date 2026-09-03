const test   = require('node:test');
const assert = require('node:assert/strict');

const engine = require('./automationEngine');

// Compuertas y antirrebote. Es lo que decide si una orden sale o no hacia un
// equipo físico, así que se prueba aparte de Firestore y del broker: estas
// funciones son puras contra el estado en memoria.

const entry = (over = {}) => ({
  tenantId: 't1', locationId: 'l1', automationId: 'a1',
  name: 'Test', enabled: true, locationEnabled: true,
  machineId: 'm1', machineName: 'Bombeo', cooldownMinutes: 0,
  triggerKind: 'telemetry',
  trigger: { kind: 'telemetry', topic: 'x', dataKey: 'v', condition: '>', threshold: '10', widgetTitle: 'V' },
  action:  { kind: 'command', topic: 'c', payload: 'ON', targetState: true },
  ...over,
});

test.beforeEach(() => engine.runState.clear());

test('una regla lista puede ejecutarse', () => {
  assert.equal(engine.blockedReason(entry()), null);
});

test('la regla desactivada no corre', () => {
  assert.equal(engine.blockedReason(entry({ enabled: false })), 'regla desactivada');
});

test('la pausa de la ubicación frena todo lo de esa location', () => {
  assert.equal(
    engine.blockedReason(entry({ locationEnabled: false })),
    'automatizaciones pausadas en la ubicación',
  );
});

// La pausa por equipo es el kill switch que puede tocar un operario. Es lo
// único, junto con desactivar la regla, que frena una automatización: el lock
// de operador se ignora a propósito.
test('el kill switch del equipo frena la automatización', () => {
  const pauseRegistry = require('./pauseRegistry');
  const original = pauseRegistry.isPaused;
  pauseRegistry.isPaused = (t, l, m) => (t === 't1' && l === 'l1' && m === 'm1');
  try {
    assert.equal(engine.blockedReason(entry()), 'equipo en pausa');
    // Otro equipo de la misma ubicación sigue habilitado.
    assert.equal(engine.blockedReason(entry({ machineId: 'm2' })), null);
  } finally {
    pauseRegistry.isPaused = original;
  }
});

test('sin cooldown configurado nunca hay espera', () => {
  const e = entry({ cooldownMinutes: 0 });
  engine.getState(e).lastRunMs = Date.now();
  assert.equal(engine.cooldownRemainingMs(e), 0);
});

test('el cooldown bloquea hasta que pasa la ventana', () => {
  const e = entry({ cooldownMinutes: 15 });
  engine.getState(e).lastRunMs = Date.now() - 5 * 60000;
  const left = engine.cooldownRemainingMs(e);
  assert.ok(left > 0, 'tendría que faltar tiempo');
  assert.ok(left <= 10 * 60000);
});

test('pasada la ventana vuelve a poder disparar', () => {
  const e = entry({ cooldownMinutes: 15 });
  engine.getState(e).lastRunMs = Date.now() - 16 * 60000;
  assert.equal(engine.cooldownRemainingMs(e), 0);
});

test('una automatización que nunca corrió no está en cooldown', () => {
  assert.equal(engine.cooldownRemainingMs(entry({ cooldownMinutes: 60 })), 0);
});

test('el estado de corrida no se mezcla entre automatizaciones', () => {
  const a = entry({ automationId: 'a1' });
  const b = entry({ automationId: 'b1' });
  engine.getState(a).lastRunMs = 12345;
  assert.equal(engine.getState(b).lastRunMs, 0);
});

test('el estado tampoco se mezcla entre tenants con el mismo id de regla', () => {
  const a = entry({ tenantId: 't1', automationId: 'a1' });
  const b = entry({ tenantId: 't2', automationId: 'a1' });
  engine.getState(a).lastRunMs = 999;
  assert.equal(engine.getState(b).lastRunMs, 0);
});

// outcomeOf es lo que queda escrito en automationState y lo que el panel
// muestra como el resultado de la última corrida. Un booleano no alcanza: hay
// que distinguir "salió y confirmó" de "salió, pero el equipo no confirmó" —
// que es justo la diferencia que le importa a un operador.
test('outcomeOf: un comando confirmado (o sin equipo que confirme) es ok', () => {
  assert.equal(engine.outcomeOf({ ok: true, confirmed: true }), 'ok');
  // Un control sin tópico de estado no tiene nada contra qué confirmar.
  assert.equal(engine.outcomeOf({ ok: true, confirmed: null }), 'ok');
  // Una notificación no lleva `confirmed` en absoluto.
  assert.equal(engine.outcomeOf({ ok: true }), 'ok');
});

test('outcomeOf: confirmed:false es "unsure", NO un fallo', () => {
  assert.equal(engine.outcomeOf({ ok: true, confirmed: false }), 'unsure');
});

test('outcomeOf: ok:false siempre es "failed", sin importar confirmed', () => {
  assert.equal(engine.outcomeOf({ ok: false }), 'failed');
  assert.equal(engine.outcomeOf({ ok: false, confirmed: false }), 'failed');
});
