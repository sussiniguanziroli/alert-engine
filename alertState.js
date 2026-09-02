const admin = require('firebase-admin');

const db = () => admin.firestore();

// Espejo en memoria del estado vivo de alarmas.
// Clave del mapa: `${tenantId}::${sourceKey}` (sourceKey == docId en Firestore).
const states    = new Map();
const listeners = [];

// Hook de notificación por email, inyectado desde index.js para evitar
// dependencia circular con emailNotifier.
let emailHook = null;
const setEmailHook = (fn) => { emailHook = fn; };

// Hook de automatizaciones encadenadas, inyectado igual y por la misma razón.
// Se dispara en el RAISE y no en cada mensaje MQTT que cumple la condición: el
// anti-martilleo de applyCondition (una alarma ya activa no se reescribe) le
// da a las automatizaciones encadenadas su antirrebote de un disparo por
// episodio, sin código extra.
let automationHook = null;
const setAutomationHook = (fn) => { automationHook = fn; };

const mkey      = (tenantId, sourceKey) => `${tenantId}::${sourceKey}`;
const alertRef  = (tenantId, sourceKey) =>
  db().collection('tenants').doc(tenantId).collection('alerts').doc(sourceKey);

const logEvent = (tenantId, ctx, eventType, actor = 'system') =>
  db().collection('tenants').doc(tenantId).collection('alarm_events').add({
    sourceKey:   ctx.sourceKey,
    locationId:  ctx.locationId  ?? null,
    machineId:   ctx.machineId   ?? null,
    widgetId:    ctx.widgetId    ?? null,
    ruleId:      ctx.ruleId      ?? null,
    widgetTitle: ctx.widgetTitle ?? null,
    title:       ctx.title       ?? null,
    severity:    ctx.severity    ?? null,
    condition:   ctx.condition   ?? null,
    value:       ctx.value != null ? String(ctx.value) : null,
    eventType,
    actor,
    at:          admin.firestore.FieldValue.serverTimestamp(),
  });

// Hidrata el espejo y lo mantiene sincronizado con cambios de operador
// (ack / shelve hechos desde el front) y con las propias escrituras del engine.
const watch = async () => {
  const tenantsSnap = await db().collection('tenants').get();
  for (const tenantDoc of tenantsSnap.docs) {
    const tenantId = tenantDoc.id;
    const unsub = alertsCol(tenantId).onSnapshot(snap => {
      snap.docChanges().forEach(change => {
        const key = mkey(tenantId, change.doc.id);
        if (change.type === 'removed') states.delete(key);
        else states.set(key, { tenantId, ...change.doc.data() });
      });
    }, err => console.error('[alertState] onSnapshot:', err.message));
    listeners.push(unsub);
  }
  console.log('🪞 [alertState] Espejo de estado sincronizado');
};

const alertsCol = (tenantId) =>
  db().collection('tenants').doc(tenantId).collection('alerts');

const raise = async (ctx, reRaise = false) => {
  const { tenantId, sourceKey } = ctx;
  const now  = admin.firestore.FieldValue.serverTimestamp();
  const prev = states.get(mkey(tenantId, sourceKey));

  const data = {
    sourceKey,   tenantId,
    locationId:  ctx.locationId  ?? null,
    machineId:   ctx.machineId   ?? null,
    widgetId:    ctx.widgetId    ?? null,
    ruleId:      ctx.ruleId      ?? null,
    widgetTitle: ctx.widgetTitle ?? null,
    title:       ctx.title       ?? null,
    dataKey:     ctx.dataKey     ?? null,
    topic:       ctx.topic       ?? null,
    severity:    ctx.severity    ?? 'warning',
    condition:   ctx.condition   ?? null,
    threshold:   ctx.threshold   ?? null,
    value:       ctx.value != null ? String(ctx.value) : '',
    state:       'UNACK',
    raisedAt:    reRaise && prev?.raisedAt ? prev.raisedAt : now,
    ackedAt:     null,
    ackedBy:     null,
    rtnAt:       null,
    emailAlert:  ctx.emailAlert ?? null,
    // En un re-disparo conservamos shelve y cooldown de email previos.
    shelvedUntil: reRaise ? (prev?.shelvedUntil ?? null) : null,
    shelvedBy:    reRaise ? (prev?.shelvedBy    ?? null) : null,
    lastEmailAt:  reRaise ? (prev?.lastEmailAt  ?? null) : null,
    updatedAt:    now,
  };

  await alertRef(tenantId, sourceKey).set(data, { merge: true });
  states.set(mkey(tenantId, sourceKey), data);
  await logEvent(tenantId, ctx, 'RAISE');
  console.log(`🚨 [alertState] RAISE ${sourceKey} (${ctx.condition} = ${ctx.value})`);

  if (emailHook) {
    try { await emailHook(tenantId, sourceKey, { ...data, ...ctx }); }
    catch (e) { console.error('[alertState] emailHook:', e.message); }
  }

  if (automationHook) {
    try { await automationHook(tenantId, sourceKey, { ...data, ...ctx }); }
    catch (e) { console.error('[alertState] automationHook:', e.message); }
  }
};

// Productor de condición: `active` indica si la condición de alarma se cumple.
// La lógica de transición sigue el modelo ISA-18.2.
const applyCondition = async (ctx, active) => {
  const { tenantId, sourceKey } = ctx;
  const cur = states.get(mkey(tenantId, sourceKey));

  if (active) {
    if (!cur)                          await raise(ctx);
    else if (cur.state === 'RTN_UNACK') await raise(ctx, true);
    // UNACK o ACK ya activas: sin re-escritura (evita martillar Firestore).
    return;
  }

  // Condición normalizada.
  if (!cur) return;

  if (cur.state === 'UNACK') {
    const patch = {
      state:     'RTN_UNACK',
      rtnAt:     admin.firestore.FieldValue.serverTimestamp(),
      value:     ctx.value != null ? String(ctx.value) : (cur.value ?? ''),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await alertRef(tenantId, sourceKey).set(patch, { merge: true });
    states.set(mkey(tenantId, sourceKey), { ...cur, ...patch });
    await logEvent(tenantId, ctx, 'RTN');
    console.log(`↩️  [alertState] RTN ${sourceKey} (normalizó, sin confirmar)`);
  } else if (cur.state === 'ACK') {
    await logEvent(tenantId, ctx, 'RTN');
    await logEvent(tenantId, ctx, 'CLEAR');
    await alertRef(tenantId, sourceKey).delete();
    states.delete(mkey(tenantId, sourceKey));
    console.log(`✅ [alertState] CLEAR ${sourceKey} (normalizó y estaba confirmada)`);
  }
  // RTN_UNACK + normalizada: ya está esperando confirmación del operador.
};

const getState     = (tenantId, sourceKey) => states.get(mkey(tenantId, sourceKey)) ?? null;

const markEmailSent = async (tenantId, sourceKey) => {
  const ts  = admin.firestore.FieldValue.serverTimestamp();
  await alertRef(tenantId, sourceKey).set({ lastEmailAt: ts }, { merge: true });
  const cur = states.get(mkey(tenantId, sourceKey));
  if (cur) states.set(mkey(tenantId, sourceKey), { ...cur, lastEmailAt: admin.firestore.Timestamp.now() });
};

const stop = () => listeners.forEach(u => u());

module.exports = { watch, applyCondition, getState, markEmailSent, setEmailHook, setAutomationHook, stop };
