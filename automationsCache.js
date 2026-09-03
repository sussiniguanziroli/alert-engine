const admin = require('firebase-admin');
const { buildCommandPayload, commandTopicFor } = require('./payload');
const { DEFAULT_TIMEZONE } = require('./cronMatch');

const db = () => admin.firestore();

// Cache reactivo de las automatizaciones, hermano de rulesCache.js.
//
// La diferencia con las alertas es que un disparo puede venir por cuatro
// caminos distintos, así que hace falta más de un índice:
//   byTopic        -> disparos por medición Y por tiempo encendido (llega un
//                      mensaje MQTT; 'runtime' además necesita el chequeo
//                      periódico de abajo, no le alcanza con el mensaje)
//   bySourceKey    -> disparos encadenados a una alarma (RAISE en alertState)
//   scheduled      -> disparos por horario (los recorre scheduler.js cada minuto)
//   runtimeWatched -> disparos por tiempo encendido (los recorre
//                      runtimeWatcher.js cada minuto, para saber si YA pasó
//                      la duración aunque no haya llegado ningún mensaje nuevo)
//
// Y una cosa más que rulesCache no necesitaba: los tópicos de ESTADO de los
// widgets que se accionan. Sin suscribirlos no hay readback, y sin readback no
// se puede saber si el equipo obedeció. rulesCache solo suscribe tópicos de
// widgets con alertas, y un botón normalmente no tiene ninguna.

const byLocation     = new Map();   // `${tenantId}/${locationId}` -> entry[]
const byTopic        = new Map();   // topic     -> entry[]
const bySourceKey    = new Map();   // sourceKey -> entry[]
let   scheduled      = [];          // entry[]
let   runtimeWatched = [];          // entry[]
const listeners      = [];

const locKey = (tenantId, locationId) => `${tenantId}/${locationId}`;

// Resuelve una automatización cruda contra los widgets de su location y la deja
// lista para ejecutar, sin volver a buscar nada en tiempo de disparo.
const buildEntry = ({ tenantId, locationId, locationName, timezone, locationEnabled, machines, widgets, automation }) => {
  const machine = machines.find(m => m.id === automation.machineId);
  const action  = automation.actions?.[0];
  if (!action) return null;

  const entry = {
    tenantId, locationId, locationName, timezone, locationEnabled,
    automationId: automation.id,
    name:         automation.name || 'Automatización',
    enabled:      automation.enabled !== false,
    machineId:    automation.machineId ?? null,
    machineName:  machine?.name || automation.machineId || 'equipo',
    cooldownMinutes: Number(automation.cooldownMinutes ?? 0),
    triggerKind:  automation.trigger?.kind,
    trigger:      null,
    action:       null,
  };

  // --- Disparo ---
  const trg = automation.trigger ?? {};
  if (trg.kind === 'telemetry') {
    const w = widgets.find(x => x.id === trg.widgetId);
    if (!w?.topic || !w?.dataKey) return null;
    if (trg.threshold === '' || trg.threshold == null) return null;
    entry.trigger = {
      kind: 'telemetry',
      topic: w.topic, dataKey: w.dataKey,
      condition: trg.condition, threshold: trg.threshold,
      widgetTitle: w.title || w.dataKey,
    };
  } else if (trg.kind === 'schedule') {
    if (!trg.cron) return null;
    entry.trigger = { kind: 'schedule', cron: trg.cron };
  } else if (trg.kind === 'alarm') {
    if (!trg.sourceKey) return null;
    entry.trigger = { kind: 'alarm', sourceKey: trg.sourceKey };
  } else if (trg.kind === 'runtime') {
    // "Encendido hace más de X" — no dispara a una hora fija (eso es
    // 'schedule'), dispara X minutos después de que ESTE widget pasa de
    // apagado a encendido. Comparte el mismo mecanismo de lectura que
    // 'telemetry' (topic + dataKey, se despacha por mensaje MQTT), pero
    // interpreta el valor como on/off en vez de como número.
    const w = widgets.find(x => x.id === trg.widgetId);
    if (!w?.topic || !w?.dataKey) return null;
    const durationMinutes = Number(trg.durationMinutes);
    if (!durationMinutes || durationMinutes <= 0) return null;
    entry.trigger = {
      kind: 'runtime',
      topic: w.topic, dataKey: w.dataKey,
      durationMinutes,
      widgetTitle: w.title || w.dataKey,
    };
  } else {
    return null;
  }

  // --- Acción ---
  if (action.kind === 'command') {
    const w = widgets.find(x => x.id === action.widgetId);
    const topic = w ? commandTopicFor(w, action.targetState) : null;
    if (!topic) return null;
    entry.action = {
      kind: 'command',
      widgetId:    w.id,
      widgetTitle: w.title || w.dataKey || 'control',
      topic,
      payload:     buildCommandPayload(w, action.targetState),
      targetState: !!action.targetState,
      // Tópico de estado del MISMO widget: es contra esto que se confirma.
      // Puede no existir (un botón de pulso sin lectura) — ahí el comando sale
      // igual y queda registrado como no confirmado.
      readbackTopic:   w.topic || null,
      readbackDataKey: w.dataKey || null,
    };
  } else if (action.kind === 'notify') {
    if (!action.recipientUids?.length) return null;
    entry.action = {
      kind: 'notify',
      recipientUids: action.recipientUids.slice(0, 10),
    };
  } else {
    return null;
  }

  // --- Aviso de fallo (opcional, independiente del tipo de acción) ---
  // A diferencia del disparo y de la acción, que si faltan invalidan toda la
  // regla, esto es opcional de verdad: null es un estado normal (no configuró
  // el aviso), no un motivo para descartar la automatización entera.
  const nof = automation.notifyOnFailure;
  entry.notifyOnFailure = (nof?.enabled && nof.recipientUids?.length)
    ? { recipientUids: nof.recipientUids.slice(0, 10) }
    : null;

  return entry;
};

const rebuildIndexes = () => {
  byTopic.clear();
  bySourceKey.clear();
  scheduled = [];
  runtimeWatched = [];

  byLocation.forEach(entries => {
    entries.forEach(e => {
      // 'telemetry' y 'runtime' comparten el mismo índice por topic: los dos
      // se despachan por mensaje MQTT, solo cambia cómo se interpreta el
      // valor una vez que llega (evaluador numérico vs on/off).
      if (e.trigger.kind === 'telemetry' || e.trigger.kind === 'runtime') {
        if (!byTopic.has(e.trigger.topic)) byTopic.set(e.trigger.topic, []);
        byTopic.get(e.trigger.topic).push(e);
      }
      if (e.trigger.kind === 'alarm') {
        if (!bySourceKey.has(e.trigger.sourceKey)) bySourceKey.set(e.trigger.sourceKey, []);
        bySourceKey.get(e.trigger.sourceKey).push(e);
      }
      if (e.trigger.kind === 'schedule') scheduled.push(e);
      if (e.trigger.kind === 'runtime')  runtimeWatched.push(e);
    });
  });
};

const load = async () => {
  console.log('⚡ [automationsCache] Cargando automatizaciones...');

  const tenantsSnap = await db().collection('tenants').get();

  for (const tenantDoc of tenantsSnap.docs) {
    const tenantId = tenantDoc.id;

    const unsub = db().collection('tenants').doc(tenantId).collection('locations')
      .onSnapshot(snap => {
        snap.docChanges().forEach(change => {
          const locationId = change.doc.id;
          const key = locKey(tenantId, locationId);
          byLocation.delete(key);
          if (change.type === 'removed') return;

          const data     = change.doc.data();
          const layout   = data.layout ?? {};
          const machines = layout.machines ?? [];
          const widgets  = layout.widgets  ?? [];
          const list     = layout.automations ?? [];
          if (!list.length) return;

          const entries = list
            .map(automation => buildEntry({
              tenantId, locationId,
              locationName:    data.name ?? locationId,
              timezone:        data.timezone || DEFAULT_TIMEZONE,
              // Pausa a nivel ubicación, gemela de `telemetry` para la ingesta.
              locationEnabled: data.automations !== false,
              machines, widgets, automation,
            }))
            .filter(Boolean);

          if (entries.length) byLocation.set(key, entries);
        });

        rebuildIndexes();

        const total = Array.from(byLocation.values()).reduce((s, a) => s + a.length, 0);
        console.log(`🔄 [automationsCache] ${tenantId} actualizado — ${total} automatizaciones ejecutables`);

        if (typeof global.__alertEngineResubscribe === 'function') {
          global.__alertEngineResubscribe();
        }
      }, err => console.error('[automationsCache] onSnapshot:', err.message));

    listeners.push(unsub);
  }

  console.log('✅ [automationsCache] Listo');
};

const getByTopic       = (topic)     => byTopic.get(topic)         ?? [];
const getBySourceKey   = (sourceKey) => bySourceKey.get(sourceKey) ?? [];
const getScheduled     = ()          => scheduled;
const getRuntimeWatched = ()         => runtimeWatched;

// Todo lo que el motor necesita escuchar por las automatizaciones: los tópicos
// que disparan Y los de estado que confirman.
const getTopics = () => {
  const topics = new Set();
  byLocation.forEach(entries => entries.forEach(e => {
    if (e.trigger.kind === 'telemetry' || e.trigger.kind === 'runtime') topics.add(e.trigger.topic);
    if (e.action.kind === 'command' && e.action.readbackTopic) topics.add(e.action.readbackTopic);
  }));
  return Array.from(topics);
};

const stop = () => listeners.forEach(u => u());

module.exports = { load, getByTopic, getBySourceKey, getScheduled, getRuntimeWatched, getTopics, stop, buildEntry };
