require('dotenv').config();
const admin          = require('firebase-admin');
const mqtt           = require('mqtt');
const rulesCache     = require('./rulesCache');
const evaluator      = require('./evaluator');
const alertState     = require('./alertState');
const emailNotifier  = require('./emailNotifier');
const offlineWatcher = require('./offlineWatcher');

const LOCAL_BROKER = process.env.MQTT_BROKER || 'mqtt://localhost:1883';
const MQTT_USER    = process.env.MQTT_USER   || '';
const MQTT_PASS    = process.env.MQTT_PASS   || '';
const PROJECT_ID   = process.env.FIREBASE_PROJECT_ID  || 'iot-admin-panel';
const SA_PATH      = process.env.SERVICE_ACCOUNT_PATH  || './serviceAccountKey.json';
const CLIENT_ID    = `alert-engine-${Math.floor(Math.random() * 9999)}`;

if (!MQTT_USER || !MQTT_PASS) {
  console.warn('⚠️  [alert-engine] Falta MQTT_USER / MQTT_PASS en el entorno (.env)');
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(SA_PATH),
    projectId:  PROJECT_ID,
  });
}

const extractValue = (payloadStr, dataKey) => {
  try {
    const parsed = JSON.parse(payloadStr);
    if (parsed[dataKey] !== undefined) return parsed[dataKey];
    const match = Object.keys(parsed).find(k => k.toLowerCase() === dataKey.toLowerCase());
    return match !== undefined ? parsed[match] : null;
  } catch {
    return payloadStr.trim();
  }
};

let mqttClient = null;

const subscribeToTopics = () => {
  if (!mqttClient?.connected) return;
  const ruleTopics    = rulesCache.getTopics();
  const machineTopics = offlineWatcher.getWatchedTopics();
  const merged        = [...new Set([...ruleTopics, ...machineTopics])];
  if (!merged.length) { console.log('⚠️  [alert-engine] Sin topics'); return; }
  mqttClient.subscribe(merged, err => {
    if (!err) console.log(`👂 [alert-engine] Suscrito a ${merged.length} topics`);
    else console.error('[alert-engine] subscribe error:', err.message);
  });
};

const start = async () => {
  console.log('🚀 [alert-engine] Iniciando...');

  alertState.setEmailHook(emailNotifier.onRaise);

  await alertState.watch();
  await rulesCache.load();
  await offlineWatcher.watchRegistry();

  global.__alertEngineResubscribe = subscribeToTopics;

  offlineWatcher.start();

  mqttClient = mqtt.connect(LOCAL_BROKER, {
    username:        MQTT_USER,
    password:        MQTT_PASS,
    clientId:        CLIENT_ID,
    reconnectPeriod: 10000,
    connectTimeout:  5000,
    clean:           true,
  });

  mqttClient.on('connect', () => {
    console.log('✅ [alert-engine] Conectado al broker');
    subscribeToTopics();
  });

  mqttClient.on('message', async (topic, message) => {
    const payloadStr = message.toString();

    offlineWatcher.updateSeenByTopic(topic);

    const entries = rulesCache.getEntriesByTopic(topic);
    for (const entry of entries) {
      const value = extractValue(payloadStr, entry.dataKey);
      if (value === null || value === undefined) continue;

      for (const rule of entry.rules) {
        const triggered = evaluator.evaluate(value, rule.condition, rule.threshold);
        await alertState.applyCondition({
          tenantId:    entry.tenantId,
          locationId:  entry.locationId,
          machineId:   entry.machineId,
          widgetId:    entry.widgetId,
          ruleId:      rule.id,
          sourceKey:   `${entry.widgetId}__${rule.id}`,
          widgetTitle: entry.widgetTitle,
          title:       rule.title || `${entry.widgetTitle} ${rule.condition} ${rule.threshold}`,
          dataKey:     entry.dataKey,
          topic,
          severity:    rule.severity,
          condition:   `${rule.condition} ${rule.threshold}`,
          threshold:   String(rule.threshold),
          value:       String(value),
          emailAlert:  rule.emailAlert ?? null,
        }, triggered);
      }
    }
  });

  mqttClient.on('reconnect', () => console.log('🔄 [alert-engine] Reconectando...'));
  mqttClient.on('error',     err => console.error('❌ [alert-engine] Error:', err.message));
  mqttClient.on('close',     ()  => console.log('🔌 [alert-engine] Conexión cerrada'));

  setInterval(subscribeToTopics, 5 * 60 * 1000);
};

process.on('SIGINT', () => {
  console.log('\n🛑 [alert-engine] Cerrando...');
  rulesCache.stop();
  alertState.stop();
  offlineWatcher.stop();
  if (mqttClient) mqttClient.end(true);
  process.exit(0);
});

start();
