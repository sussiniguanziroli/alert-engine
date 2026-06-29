const admin      = require('firebase-admin');
const alertState = require('./alertState');

const db = () => admin.firestore();

// Todo se indexa por machineKey = `${tenantId}::${locationId}::${machineId}`
// para evitar colisiones de machineId entre locations.
const machineRegistry = new Map();   // machineKey -> { tenantId, locationId, machineId, machineName, timeoutMs, topics }
const topicToMachines = new Map();   // topic -> Set<machineKey>
const lastSeen        = new Map();   // machineKey -> ts
const listeners       = [];

const DEFAULT_TIMEOUT_MIN = 15;

const mkey = (tenantId, locationId, machineId) => `${tenantId}::${locationId}::${machineId}`;

const offlineCtx = (entry, value = '', condition = 'sin datos') => ({
  tenantId:    entry.tenantId,
  locationId:  entry.locationId,
  machineId:   entry.machineId,
  widgetId:    null,
  ruleId:      'offline',
  sourceKey:   `offline__${entry.machineId}`,
  widgetTitle: entry.machineName,
  title:       `Sin datos — ${entry.machineName}`,
  dataKey:     'offline',
  topic:       '',
  severity:    'warning',
  condition,
  threshold:   null,
  value,
  emailAlert:  null,
});

const registerMachine = ({ tenantId, locationId, machineId, machineName, timeoutMinutes, topics = [] }) => {
  const key       = mkey(tenantId, locationId, machineId);
  const timeoutMs = (timeoutMinutes ?? DEFAULT_TIMEOUT_MIN) * 60 * 1000;
  machineRegistry.set(key, { tenantId, locationId, machineId, machineName, timeoutMs, topics });
  topics.forEach(t => {
    if (!topicToMachines.has(t)) topicToMachines.set(t, new Set());
    topicToMachines.get(t).add(key);
  });
};

const clearLocation = (tenantId, locationId) => {
  const prefix = `${tenantId}::${locationId}::`;
  for (const key of Array.from(machineRegistry.keys())) {
    if (!key.startsWith(prefix)) continue;
    machineRegistry.delete(key);
    lastSeen.delete(key);
    topicToMachines.forEach(set => set.delete(key));
  }
  for (const [t, set] of Array.from(topicToMachines.entries())) {
    if (set.size === 0) topicToMachines.delete(t);
  }
};

// Registro reactivo: si se agrega/edita una máquina, se refleja sin reiniciar.
const watchRegistry = async () => {
  const tenantsSnap = await db().collection('tenants').get();
  for (const tenantDoc of tenantsSnap.docs) {
    const tenantId = tenantDoc.id;
    const unsub = db().collection('tenants').doc(tenantId).collection('locations')
      .onSnapshot(snap => {
        snap.docChanges().forEach(change => {
          const locationId = change.doc.id;
          clearLocation(tenantId, locationId);
          if (change.type === 'removed') return;

          const data     = change.doc.data();
          const machines = data.layout?.machines ?? [];
          const widgets  = data.layout?.widgets  ?? [];

          machines.forEach(m => {
            const mWidgets = widgets.filter(w => w.machineId === m.id && w.topic);
            if (!mWidgets.length) return;
            registerMachine({
              tenantId, locationId,
              machineId:      m.id,
              machineName:    m.name || m.id,
              timeoutMinutes: m.offlineTimeoutMinutes ?? DEFAULT_TIMEOUT_MIN,
              topics:         [...new Set(mWidgets.map(w => w.topic))],
            });
          });
        });

        if (typeof global.__alertEngineResubscribe === 'function') {
          global.__alertEngineResubscribe();
        }
      }, err => console.error('[offlineWatcher] onSnapshot:', err.message));
    listeners.push(unsub);
  }
  console.log('📋 [offlineWatcher] Registro de máquinas reactivo');
};

const updateSeenByTopic = (topic) => {
  const machines = topicToMachines.get(topic);
  if (!machines) return;
  const now = Date.now();
  machines.forEach(key => {
    lastSeen.set(key, now);
    const entry = machineRegistry.get(key);
    if (entry) alertState.applyCondition(offlineCtx(entry), false);
  });
};

const getWatchedTopics = () => Array.from(topicToMachines.keys());

const check = async () => {
  const now = Date.now();
  for (const [key, entry] of machineRegistry.entries()) {
    const last = lastSeen.get(key);
    if (!last) continue;
    const elapsed = now - last;
    if (elapsed > entry.timeoutMs) {
      const mins = Math.round(elapsed / 60000);
      await alertState.applyCondition(
        offlineCtx(entry, `${mins} min`, `sin datos por ${mins} min`),
        true,
      );
    }
  }
};

const start = () => {
  setInterval(check, 60 * 1000);
  console.log('👁️  [offlineWatcher] Iniciado');
};

const stop = () => listeners.forEach(u => u());

module.exports = { start, watchRegistry, updateSeenByTopic, getWatchedTopics, stop };
