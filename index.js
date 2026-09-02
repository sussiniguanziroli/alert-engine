require('dotenv').config();
const admin            = require('firebase-admin');
const mqtt             = require('mqtt');
const rulesCache       = require('./rulesCache');
const evaluator        = require('./evaluator');
const alertState       = require('./alertState');
const emailNotifier    = require('./emailNotifier');
const offlineWatcher   = require('./offlineWatcher');
const automationsCache = require('./automationsCache');
const automationEngine = require('./automationEngine');
const commandSender    = require('./commandSender');
const pauseRegistry    = require('./pauseRegistry');
const scheduler        = require('./scheduler');
const { extractValue } = require('./payload');

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

let mqttClient = null;

// Tres fuentes de tópicos, no dos: a las reglas de alerta y a las máquinas
// vigiladas se suma ahora lo que necesitan las automatizaciones — los tópicos
// que las disparan Y los de estado contra los que se confirma un comando. Sin
// estos últimos no hay readback: un widget de control normalmente no tiene
// ninguna regla de alerta, así que rulesCache nunca lo suscribiría.
const subscribeToTopics = () => {
  if (!mqttClient?.connected) return;
  const merged = [...new Set([
    ...rulesCache.getTopics(),
    ...offlineWatcher.getWatchedTopics(),
    ...automationsCache.getTopics(),
  ])];
  if (!merged.length) { console.log('⚠️  [alert-engine] Sin topics'); return; }
  mqttClient.subscribe(merged, err => {
    if (!err) console.log(`👂 [alert-engine] Suscrito a ${merged.length} topics`);
    else console.error('[alert-engine] subscribe error:', err.message);
  });
};

// Disparo encadenado: cuando alertState levanta una alarma, se buscan las
// automatizaciones atadas a ese sourceKey.
const onAlarmRaised = async (tenantId, sourceKey, alert) => {
  const entries = automationsCache.getBySourceKey(sourceKey);
  for (const entry of entries) {
    if (entry.tenantId !== tenantId) continue;
    await automationEngine.trigger(entry, `alarma "${alert.title || sourceKey}"`);
  }
};

const start = async () => {
  console.log('🚀 [alert-engine] Iniciando...');

  alertState.setEmailHook(emailNotifier.onRaise);
  alertState.setAutomationHook(onAlarmRaised);

  await alertState.watch();
  await rulesCache.load();
  await offlineWatcher.watchRegistry();
  await automationsCache.load();
  await pauseRegistry.watch();
  await automationEngine.hydrate();

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

  automationEngine.setClient(mqttClient);

  mqttClient.on('connect', () => {
    console.log('✅ [alert-engine] Conectado al broker');
    subscribeToTopics();
    // El scheduler arranca recién con el broker arriba: si recupera una corrida
    // vencida, el comando tiene que poder salir de verdad.
    scheduler.start().catch(e => console.error('[alert-engine] scheduler:', e.message));
  });

  mqttClient.on('message', async (topic, message) => {
    const payloadStr = message.toString();

    offlineWatcher.updateSeenByTopic(topic);

    // Readback de comandos automáticos: se atiende primero y siempre, porque
    // hay una promesa esperando con timeout del otro lado.
    commandSender.handleMessage(topic, payloadStr);

    // --- Reglas de alerta ---
    for (const entry of rulesCache.getEntriesByTopic(topic)) {
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

    // --- Automatizaciones por medición ---
    for (const entry of automationsCache.getByTopic(topic)) {
      const value = extractValue(payloadStr, entry.trigger.dataKey);
      if (value === null || value === undefined) continue;
      const active = evaluator.evaluate(value, entry.trigger.condition, entry.trigger.threshold);
      await automationEngine.applyTelemetry(entry, active, value);
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
  automationsCache.stop();
  pauseRegistry.stop();
  scheduler.stop();
  if (mqttClient) mqttClient.end(true);
  process.exit(0);
});

start();
