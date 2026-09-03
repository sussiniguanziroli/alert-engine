const test   = require('node:test');
const assert = require('node:assert/strict');

const { buildEntry } = require('./automationsCache');

// buildEntry resuelve una automatización cruda contra los widgets de su
// ubicación. Es donde se decide qué es EJECUTABLE: todo lo que devuelva null
// nunca va a llegar al motor, así que sus bordes importan tanto como el
// disparo en sí.

const machines = [{ id: 'm1', name: 'Bombeo Norte' }];
const widgets = [
  { id: 'w1', title: 'Temperatura', dataKey: 'temp', topic: 'planta/temp', unit: '°C' },
  { id: 'w2', title: 'Bomba A', dataKey: 'st', topic: 'planta/bomba/estado',
    commandTopic: 'planta/bomba/cmd', onCommand: 'ON', offCommand: 'OFF' },
  { id: 'w3', title: 'Pulso', commandTopic: 'planta/pulso' },   // sin tópico de lectura
  { id: 'w4', title: 'Sensor solo lectura', dataKey: 'x', topic: 'planta/x' },
];

const base = (over = {}) => ({
  tenantId: 't1', locationId: 'l1', locationName: 'Planta',
  timezone: 'America/Argentina/Buenos_Aires', locationEnabled: true,
  machines, widgets,
  automation: {
    id: 'a1', name: 'Test', enabled: true, machineId: 'm1',
    trigger: { kind: 'telemetry', widgetId: 'w1', condition: '>', threshold: '80' },
    actions: [{ kind: 'command', widgetId: 'w2', targetState: true }],
    cooldownMinutes: 15,
    ...over,
  },
});

test('resuelve una automatización completa por medición', () => {
  const e = buildEntry(base());
  assert.ok(e);
  assert.equal(e.machineName, 'Bombeo Norte');
  assert.equal(e.trigger.topic, 'planta/temp');
  assert.equal(e.trigger.dataKey, 'temp');
  assert.equal(e.action.topic, 'planta/bomba/cmd');
  assert.equal(e.action.payload, 'ON');
  // El readback apunta al tópico de ESTADO del mismo widget, no al de comando.
  assert.equal(e.action.readbackTopic, 'planta/bomba/estado');
  assert.equal(e.action.readbackDataKey, 'st');
});

test('el payload sigue el targetState', () => {
  const e = buildEntry(base({ actions: [{ kind: 'command', widgetId: 'w2', targetState: false }] }));
  assert.equal(e.action.payload, 'OFF');
  assert.equal(e.action.targetState, false);
});

test('un control sin tópico de estado se acepta, pero sin readback', () => {
  const e = buildEntry(base({ actions: [{ kind: 'command', widgetId: 'w3', targetState: true }] }));
  assert.ok(e);
  assert.equal(e.action.topic, 'planta/pulso');
  assert.equal(e.action.readbackTopic, null);
});

test('descarta si el widget del disparo no tiene tópico o dataKey', () => {
  assert.equal(buildEntry(base({ trigger: { kind: 'telemetry', widgetId: 'nope', condition: '>', threshold: '1' } })), null);
});

test('descarta si falta el umbral — sin él evaluate() nunca daría true', () => {
  assert.equal(buildEntry(base({ trigger: { kind: 'telemetry', widgetId: 'w1', condition: '>', threshold: '' } })), null);
  assert.equal(buildEntry(base({ trigger: { kind: 'telemetry', widgetId: 'w1', condition: '>' } })), null);
});

test('acepta umbral cero, que es un valor legítimo', () => {
  const e = buildEntry(base({ trigger: { kind: 'telemetry', widgetId: 'w1', condition: '<', threshold: '0' } }));
  assert.ok(e);
  assert.equal(e.trigger.threshold, '0');
});

test('descarta si el widget a accionar no se puede comandar', () => {
  assert.equal(buildEntry(base({ actions: [{ kind: 'command', widgetId: 'w4', targetState: true }] })), null);
  assert.equal(buildEntry(base({ actions: [{ kind: 'command', widgetId: 'nope', targetState: true }] })), null);
});

test('descarta una notificación sin destinatarios', () => {
  assert.equal(buildEntry(base({ actions: [{ kind: 'notify', recipientUids: [] }] })), null);
  const e = buildEntry(base({ actions: [{ kind: 'notify', recipientUids: ['u1', 'u2'] }] }));
  assert.ok(e);
  assert.deepEqual(e.action.recipientUids, ['u1', 'u2']);
});

test('corta los destinatarios en 10 — es el tope del where(in) de Firestore', () => {
  const many = Array.from({ length: 25 }, (_, i) => `u${i}`);
  const e = buildEntry(base({ actions: [{ kind: 'notify', recipientUids: many }] }));
  assert.equal(e.action.recipientUids.length, 10);
});

test('descarta un disparo por horario sin cron y uno por alarma sin sourceKey', () => {
  assert.equal(buildEntry(base({ trigger: { kind: 'schedule' } })), null);
  assert.equal(buildEntry(base({ trigger: { kind: 'alarm' } })), null);

  assert.ok(buildEntry(base({ trigger: { kind: 'schedule', cron: '0 6 * * *' } })));
  assert.ok(buildEntry(base({ trigger: { kind: 'alarm', sourceKey: 'w1__r1' } })));
});

test('descarta tipos de disparo o de acción desconocidos', () => {
  assert.equal(buildEntry(base({ trigger: { kind: 'telepatia' } })), null);
  assert.equal(buildEntry(base({ actions: [{ kind: 'sarasa' }] })), null);
  assert.equal(buildEntry(base({ actions: [] })), null);
});

// Una regla desactivada SÍ se indexa: el motor la filtra al disparar. Así,
// reactivarla desde el panel no depende de que se reconstruya el cache.
test('una automatización desactivada se resuelve igual, marcada como tal', () => {
  const e = buildEntry(base({ enabled: false }));
  assert.ok(e);
  assert.equal(e.enabled, false);
});

test('arrastra la pausa de la ubicación y la zona horaria', () => {
  const e = buildEntry({ ...base(), locationEnabled: false, timezone: 'America/Santiago' });
  assert.equal(e.locationEnabled, false);
  assert.equal(e.timezone, 'America/Santiago');
});

// El aviso de fallo es opcional de verdad: a diferencia del disparo y la
// acción, que si faltan invalidan toda la regla, acá null es un estado
// normal — no lo configuraron, no es un motivo para descartar la automatización.
test('sin notifyOnFailure configurado, la entrada se resuelve igual con el campo en null', () => {
  const e = buildEntry(base());
  assert.ok(e);
  assert.equal(e.notifyOnFailure, null);
});

test('notifyOnFailure desactivado o sin destinatarios queda en null', () => {
  assert.equal(buildEntry(base({ notifyOnFailure: { enabled: false, recipientUids: ['u1'] } })).notifyOnFailure, null);
  assert.equal(buildEntry(base({ notifyOnFailure: { enabled: true, recipientUids: [] } })).notifyOnFailure, null);
});

test('notifyOnFailure con destinatarios se resuelve y corta en 10', () => {
  const e = buildEntry(base({ notifyOnFailure: { enabled: true, recipientUids: ['u1', 'u2'] } }));
  assert.deepEqual(e.notifyOnFailure, { recipientUids: ['u1', 'u2'] });

  const many = Array.from({ length: 25 }, (_, i) => `u${i}`);
  const e2 = buildEntry(base({ notifyOnFailure: { enabled: true, recipientUids: many } }));
  assert.equal(e2.notifyOnFailure.recipientUids.length, 10);
});

// --- Disparo por tiempo encendido ('runtime') ---

test('resuelve un disparo por tiempo encendido contra un widget con lectura', () => {
  const e = buildEntry(base({
    trigger: { kind: 'runtime', widgetId: 'w2', durationMinutes: 120 },
  }));
  assert.ok(e);
  assert.deepEqual(e.trigger, {
    kind: 'runtime', topic: 'planta/bomba/estado', dataKey: 'st',
    durationMinutes: 120, widgetTitle: 'Bomba A',
  });
});

test('descarta si el widget no tiene tópico o dataKey para leer su estado', () => {
  // w3 tiene commandTopic pero no topic/dataKey — se puede accionar, no vigilar.
  assert.equal(buildEntry(base({ trigger: { kind: 'runtime', widgetId: 'w3', durationMinutes: 60 } })), null);
  assert.equal(buildEntry(base({ trigger: { kind: 'runtime', widgetId: 'nope', durationMinutes: 60 } })), null);
});

test('descarta una duración inválida', () => {
  assert.equal(buildEntry(base({ trigger: { kind: 'runtime', widgetId: 'w2', durationMinutes: 0 } })), null);
  assert.equal(buildEntry(base({ trigger: { kind: 'runtime', widgetId: 'w2', durationMinutes: -5 } })), null);
  assert.equal(buildEntry(base({ trigger: { kind: 'runtime', widgetId: 'w2' } })), null);
  assert.equal(buildEntry(base({ trigger: { kind: 'runtime', widgetId: 'w2', durationMinutes: 'abc' } })), null);
});
