const admin = require('firebase-admin');
const pauseRegistry = require('./pauseRegistry');
const commandSender = require('./commandSender');

const db = () => admin.firestore();

// Ejecutor de automatizaciones: decide si una regla puede correr, la corre, y
// deja rastro de lo que pasó.
//
// El actor de todo lo que sale de acá es 'LightBug Automation'. En el historial
// hay tres actores distinguibles: el uid de una persona, 'system' (las fallas
// que registra el panel) y este. Que una orden a un equipo haya salido sola o
// la haya apretado alguien no puede quedar ambiguo.
const ACTOR      = 'LightBug Automation';
const ACTOR_ID   = 'lightbug';

let mqttClient = null;
const setClient = (c) => { mqttClient = c; };

// Estado de corrida por automatización. Se hidrata al arrancar desde
// automationState y se mantiene en memoria durante la ejecución.
//   `${tenantId}/${automationId}` -> { lastRunMs, conditionActive }
const runState = new Map();
const rsKey = (tenantId, automationId) => `${tenantId}/${automationId}`;

const stateRef = (entry) => db()
  .collection('tenants').doc(entry.tenantId)
  .collection('locations').doc(entry.locationId)
  .collection('automationState').doc(entry.automationId);

// El estado de corrida NO va dentro de layout.automations a propósito: ese
// documento lo reescribe el panel entero en cada edición, y meter ahí una
// escritura por disparo significaría (a) una condición de carrera contra el
// editor y (b) despertar el onSnapshot del dashboard de todos los usuarios
// conectados cada vez que una bomba arranca. Un documento chico aparte no
// tiene ninguno de los dos problemas.
const hydrate = async () => {
  try {
    const snap = await db().collectionGroup('automationState').get();
    snap.forEach(doc => {
      const p = doc.ref.path.split('/');   // tenants/{t}/locations/{l}/automationState/{id}
      const d = doc.data();
      const last = d.lastRunAt?.toMillis ? d.lastRunAt.toMillis() : 0;
      runState.set(rsKey(p[1], doc.id), { lastRunMs: last, conditionActive: false });
    });
    console.log(`💾 [automationEngine] Estado de ${snap.size} automatización(es) recuperado`);
  } catch (e) {
    // Sin índice o sin datos todavía: no es fatal, solo significa que el
    // antirrebote arranca en cero.
    console.warn('[automationEngine] hydrate:', e.message);
  }
};

const getState = (entry) => {
  const k = rsKey(entry.tenantId, entry.automationId);
  if (!runState.has(k)) runState.set(k, { lastRunMs: 0, conditionActive: false });
  return runState.get(k);
};

const logEvent = (entry, eventType, detail = {}) =>
  db().collection('tenants').doc(entry.tenantId).collection('automation_events').add({
    automationId:   entry.automationId,
    automationName: entry.name,
    locationId:     entry.locationId,
    machineId:      entry.machineId,
    machineName:    entry.machineName,
    triggerKind:    entry.triggerKind,
    actionKind:     entry.action.kind,
    eventType,
    actor:          ACTOR,
    actorId:        ACTOR_ID,
    ...detail,
    at: admin.firestore.FieldValue.serverTimestamp(),
  });

// Auditoría general, la misma colección que mira el panel de administración.
const logAudit = (entry, action, metadata) =>
  db().collection('audit_logs').add({
    timestamp:  admin.firestore.FieldValue.serverTimestamp(),
    actor:      ACTOR,
    actorId:    ACTOR_ID,
    actorRole:  'automation',
    action,
    category:   'DEVICE_CONTROL',
    target:     entry.machineName,
    tenantId:   entry.tenantId,
    locationId: entry.locationId,
    machineId:  entry.machineId,
    metadata:   { automationId: entry.automationId, automationName: entry.name, ...metadata },
  }).catch(e => console.error('[automationEngine] logAudit:', e.message));

// Por qué NO se puede ejecutar, o null si puede. Devolver el motivo (en vez de
// un booleano) hace que el log diga algo útil cuando algo no corre.
const blockedReason = (entry) => {
  if (!entry.enabled)         return 'regla desactivada';
  if (!entry.locationEnabled) return 'automatizaciones pausadas en la ubicación';
  if (entry.machineId && pauseRegistry.isPaused(entry.tenantId, entry.locationId, entry.machineId)) {
    return 'equipo en pausa';
  }
  return null;
};

const cooldownRemainingMs = (entry) => {
  const mins = entry.cooldownMinutes;
  if (!mins) return 0;
  const { lastRunMs } = getState(entry);
  if (!lastRunMs) return 0;
  const elapsed = Date.now() - lastRunMs;
  return elapsed >= mins * 60000 ? 0 : mins * 60000 - elapsed;
};

const persistRun = async (entry, ok, detail) => {
  const st = getState(entry);
  st.lastRunMs = Date.now();
  try {
    await stateRef(entry).set({
      lastRunAt:  admin.firestore.FieldValue.serverTimestamp(),
      lastRunOk:  ok,
      lastDetail: detail ?? null,
      automationName: entry.name,
      machineId:  entry.machineId ?? null,
    }, { merge: true });
  } catch (e) {
    console.error('[automationEngine] persistRun:', e.message);
  }
};

const runNotify = async (entry, reason) => {
  const usersSnap = await db().collection('users')
    .where(admin.firestore.FieldPath.documentId(), 'in', entry.action.recipientUids)
    .get();
  const emails = usersSnap.docs.map(d => d.data().email).filter(Boolean);
  if (!emails.length) return { ok: false, detail: 'sin destinatarios con email' };

  await db().collection('email_trigger_queue').add({
    to: emails,
    message: {
      subject: `[LightBug] ${entry.name} — ${entry.machineName}`,
      html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#f1f5f9;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;padding:28px 32px;">
    <p style="margin:0 0 4px;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#7fb238;">LightBug Automations</p>
    <h1 style="margin:0 0 16px;font-size:20px;color:#0f172a;">${entry.name}</h1>
    <p style="margin:0 0 8px;font-size:14px;color:#334155;">Se cumplió la condición configurada en <b>${entry.machineName}</b>.</p>
    <p style="margin:0 0 20px;font-size:13px;color:#64748b;font-family:monospace;">${reason}</p>
    <a href="https://sflightbug.com/app/home" style="display:inline-block;background:#1e293b;color:#fff;text-decoration:none;padding:12px 28px;border-radius:9px;font-weight:700;font-size:13px;">Ver en el panel</a>
    <p style="margin:22px 0 0;font-size:11px;color:#94a3b8;">Mensaje automático de SF LightBug · plataforma@sfflow.com.ar</p>
  </div>
</body></html>`,
    },
  });
  return { ok: true, detail: `email a ${emails.length} destinatario(s)` };
};

const runCommand = async (entry) => {
  const res = await commandSender.sendCommand(mqttClient, entry.action);
  if (!res.published) return { ok: false, detail: `no se pudo publicar: ${res.error}`, confirmed: false };
  if (res.confirmed === null) {
    return { ok: true, detail: 'comando enviado (el control no tiene tópico de estado)', confirmed: null };
  }
  return {
    ok: true,
    confirmed: res.confirmed,
    detail: res.confirmed ? 'confirmado por el equipo' : 'enviado, sin confirmación del equipo',
  };
};

// Punto de entrada único de los tres tipos de disparo.
const trigger = async (entry, reason) => {
  const blocked = blockedReason(entry);
  if (blocked) {
    console.log(`⛔ [automationEngine] ${entry.name}: ${blocked}`);
    return;
  }

  const remaining = cooldownRemainingMs(entry);
  if (remaining > 0) {
    console.log(`⏳ [automationEngine] ${entry.name}: en espera (${Math.ceil(remaining / 60000)} min)`);
    return;
  }

  // Se marca el disparo ANTES de ejecutar: si la acción tarda, un segundo
  // mensaje que llegue mientras tanto no puede colarse por la ventana abierta.
  getState(entry).lastRunMs = Date.now();

  console.log(`⚡ [automationEngine] ${entry.name} — ${reason}`);
  await logEvent(entry, 'TRIGGERED', { reason });

  let result;
  try {
    result = entry.action.kind === 'command'
      ? await runCommand(entry)
      : await runNotify(entry, reason);
  } catch (e) {
    result = { ok: false, detail: e.message };
  }

  if (entry.action.kind === 'command') {
    await logEvent(entry, result.ok ? 'COMMAND_SENT' : 'FAILED', {
      topic:     entry.action.topic,
      payload:   entry.action.payload,
      confirmed: result.confirmed ?? null,
      detail:    result.detail,
    });
    logAudit(entry, result.ok ? 'AUTOMATION_COMMAND_SENT' : 'AUTOMATION_FAILED', {
      topic:     entry.action.topic,
      payload:   entry.action.payload,
      confirmed: result.confirmed ?? null,
      reason,
    });
  } else {
    await logEvent(entry, result.ok ? 'NOTIFIED' : 'FAILED', { detail: result.detail });
  }

  await persistRun(entry, result.ok, result.detail);
  console.log(`${result.ok ? '✅' : '❌'} [automationEngine] ${entry.name}: ${result.detail}`);
};

// Disparo por medición. Solo en el FLANCO (la condición pasa de falsa a
// verdadera), no en cada mensaje que la sigue cumpliendo: si no, una variable
// que se queda arriba del umbral mandaría un comando por cada lectura.
const applyTelemetry = async (entry, active, value) => {
  const st = getState(entry);
  const was = st.conditionActive;
  st.conditionActive = active;
  if (!active || was) return;
  await trigger(entry, `${entry.trigger.widgetTitle} ${entry.trigger.condition} ${entry.trigger.threshold} (valor ${value})`);
};

module.exports = {
  ACTOR, ACTOR_ID,
  setClient, hydrate, trigger, applyTelemetry,
  blockedReason, cooldownRemainingMs, getState, runState,
};
