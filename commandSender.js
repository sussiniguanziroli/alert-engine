const { extractValue } = require('./payload');
const { parseSwitchOn } = require('./boolTokens');

// Envío de un comando con confirmación, equivalente del backend a lo que hace
// sendCommand() en useMachineControls.js del panel: publicar con QoS1 y esperar
// a que el equipo devuelva el estado nuevo por su tópico de lectura.
//
// El PUBACK de QoS1 solo dice que el BROKER recibió el mensaje. Que el equipo
// haya obedecido es otra cosa, y es lo único que vale registrar en la auditoría
// de una acción que nadie miró ejecutarse.

const CONFIRM_TIMEOUT_MS = 8000;

// readbackTopic -> Set<{ targetState, dataKey, resolve, timer }>
const waiting = new Map();

// La llama el loop de mensajes de index.js con CADA mensaje. Si nadie está
// esperando ese tópico, no hace nada.
const handleMessage = (topic, payloadStr) => {
  const waiters = waiting.get(topic);
  if (!waiters?.size) return;

  for (const w of Array.from(waiters)) {
    const value = extractValue(payloadStr, w.dataKey);
    if (value === null || value === undefined) continue;
    if (parseSwitchOn(value) !== w.targetState) continue;
    clearTimeout(w.timer);
    waiters.delete(w);
    w.resolve(true);
  }
  if (!waiters.size) waiting.delete(topic);
};

const waitForReadback = (topic, dataKey, targetState, timeoutMs) => new Promise(resolve => {
  if (!waiting.has(topic)) waiting.set(topic, new Set());
  const waiters = waiting.get(topic);

  const w = { targetState, dataKey, resolve, timer: null };
  w.timer = setTimeout(() => {
    waiters.delete(w);
    if (!waiters.size) waiting.delete(topic);
    resolve(false);
  }, timeoutMs);

  waiters.add(w);
});

// Publica y espera confirmación. Devuelve { published, confirmed }.
//
// `published:false` es un fallo de verdad (no hay broker). `confirmed:false`
// con `published:true` significa que el comando salió pero el equipo no
// devolvió el estado esperado a tiempo: puede ser un equipo lento, un tópico de
// estado mal configurado, o que realmente no obedeció. Se registra tal cual, sin
// interpretarlo.
const sendCommand = async (client, action, { timeoutMs = CONFIRM_TIMEOUT_MS } = {}) => {
  if (!client?.connected) return { published: false, confirmed: false, error: 'broker desconectado' };

  // Se empieza a escuchar ANTES de publicar: un equipo rápido puede contestar
  // antes de que termine el await del publish.
  const readback = action.readbackTopic
    ? waitForReadback(action.readbackTopic, action.readbackDataKey || 'value', action.targetState, timeoutMs)
    : null;

  try {
    await new Promise((resolve, reject) => {
      client.publish(action.topic, action.payload, { qos: 1 }, err => (err ? reject(err) : resolve()));
    });
  } catch (e) {
    return { published: false, confirmed: false, error: e.message };
  }

  if (!readback) return { published: true, confirmed: null };
  return { published: true, confirmed: await readback };
};

module.exports = { sendCommand, handleMessage, CONFIRM_TIMEOUT_MS };
