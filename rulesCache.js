const admin = require('firebase-admin');

const db = () => admin.firestore();

const topicRulesMap = new Map();   // `${tenantId}/${locationId}/${topic}` -> entry[]
const byTopic       = new Map();   // topic -> entry[]  (índice O(1) por topic)
const listeners     = [];

const buildKey = (tenantId, locationId, topic) => `${tenantId}/${locationId}/${topic}`;

const rebuildByTopic = () => {
  byTopic.clear();
  topicRulesMap.forEach((entries, key) => {
    const topic = key.split('/').slice(2).join('/');
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(...entries);
  });
};

const load = async () => {
  console.log('📋 [rulesCache] Cargando reglas...');

  const tenantsSnap = await db().collection('tenants').get();

  for (const tenantDoc of tenantsSnap.docs) {
    const tenantId    = tenantDoc.id;
    const locationsRef = db().collection('tenants').doc(tenantId).collection('locations');

    const unsub = locationsRef.onSnapshot(snap => {
      snap.docChanges().forEach(change => {
        const locationId = change.doc.id;
        const data       = change.doc.data();

        const oldKeys = Array.from(topicRulesMap.keys())
          .filter(k => k.startsWith(`${tenantId}/${locationId}/`));
        oldKeys.forEach(k => topicRulesMap.delete(k));

        if (change.type === 'removed') return;

        const widgets = data.layout?.widgets ?? [];
        widgets.forEach(w => {
          if (!w.topic || !w.dataKey) return;
          const rules = (w.alertRules ?? []).filter(r => r.enabled);
          if (!rules.length) return;

          const key = buildKey(tenantId, locationId, w.topic);
          if (!topicRulesMap.has(key)) topicRulesMap.set(key, []);

          topicRulesMap.get(key).push({
            tenantId,
            locationId,
            machineId:   w.machineId   || 'general',
            widgetId:    w.id,
            widgetTitle: w.title       || w.dataKey,
            dataKey:     w.dataKey,
            rules,
          });
        });

        rebuildByTopic();

        const total = Array.from(topicRulesMap.values()).reduce((s, a) => s + a.length, 0);
        console.log(`🔄 [rulesCache] ${tenantId}/${locationId} actualizado — ${total} entradas activas`);

        if (typeof global.__alertEngineResubscribe === 'function') {
          global.__alertEngineResubscribe();
        }
      });
    }, err => console.error('[rulesCache] onSnapshot error:', err));

    listeners.push(unsub);
  }

  console.log('✅ [rulesCache] Listo');
};

const getEntries = (tenantId, locationId, topic) => {
  const key = buildKey(tenantId, locationId, topic);
  return topicRulesMap.get(key) ?? [];
};

// Todas las entradas (de cualquier tenant/location) suscritas a un topic.
const getEntriesByTopic = (topic) => byTopic.get(topic) ?? [];

const getTopics = () => {
  const topics = new Set();
  topicRulesMap.forEach((_, key) => {
    const parts = key.split('/');
    topics.add(parts.slice(2).join('/'));
  });
  return Array.from(topics);
};

const getAllKeys = () => Array.from(topicRulesMap.keys());

const stop = () => listeners.forEach(u => u());

module.exports = { load, getEntries, getEntriesByTopic, getTopics, getAllKeys, stop };
