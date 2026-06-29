const admin      = require('firebase-admin');
const alertState = require('./alertState');

const db = () => admin.firestore();

const buildEmailHtml = ({ machineName, widgetTitle, severity, condition, value, locationName, tenantName, dateStr }) => {
  const color = severity === 'fault' ? '#ef4444' : '#f97316';
  const label = severity === 'fault' ? 'FALLA' : 'AVISO';
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#f1f5f9;">
<table role="presentation" style="width:100%;background:#f1f5f9;"><tr><td style="padding:40px 20px;">
<table role="presentation" style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 10px 25px rgba(0,0,0,0.1);">
<tr><td style="background:${color};padding:32px 40px;text-align:center;">
  <div style="display:inline-block;width:56px;height:56px;background:rgba(255,255,255,0.2);border-radius:14px;line-height:56px;margin-bottom:16px;">
    <span style="font-size:28px;font-weight:800;color:#fff;">F</span>
  </div>
  <h1 style="margin:0;color:#fff;font-size:22px;font-weight:800;">Alerta ${label}</h1>
  <p style="margin:8px 0 0;color:rgba(255,255,255,0.9);font-size:14px;">${tenantName || 'Fortunato SCADA'}</p>
</td></tr>
<tr><td style="padding:32px 40px;">
  <table role="presentation" style="width:100%;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden;margin-bottom:24px;">
    <tr><td style="padding:14px 18px;border-bottom:1px solid #e2e8f0;">
      <span style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">Equipo</span><br>
      <span style="font-size:15px;font-weight:700;color:#0f172a;">${machineName || '—'}</span>
    </td></tr>
    <tr><td style="padding:14px 18px;border-bottom:1px solid #e2e8f0;">
      <span style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">Variable</span><br>
      <span style="font-size:15px;font-weight:700;color:#0f172a;">${widgetTitle || '—'}</span>
    </td></tr>
    <tr><td style="padding:14px 18px;border-bottom:1px solid #e2e8f0;">
      <span style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">Condición</span><br>
      <span style="font-size:15px;font-weight:700;color:${color};font-family:monospace;">${condition} — valor: ${value}</span>
    </td></tr>
    <tr><td style="padding:14px 18px;border-bottom:1px solid #e2e8f0;">
      <span style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">Ubicación</span><br>
      <span style="font-size:15px;font-weight:700;color:#0f172a;">${locationName || '—'}</span>
    </td></tr>
    <tr><td style="padding:14px 18px;">
      <span style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">Fecha y hora</span><br>
      <span style="font-size:15px;font-weight:700;color:#0f172a;">${dateStr}</span>
    </td></tr>
  </table>
  <div style="text-align:center;margin:32px 0;">
    <a href="https://iot-admin-panel.netlify.app/app/home" style="display:inline-block;background:#1e293b;color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-weight:700;font-size:14px;">Ver en el panel</a>
  </div>
  <p style="margin:0;color:#94a3b8;font-size:12px;text-align:center;">Este mensaje fue generado automáticamente por Fortunato SCADA.</p>
</td></tr>
<tr><td style="background:#f8fafc;padding:20px 40px;text-align:center;border-top:1px solid #e2e8f0;">
  <p style="margin:0;color:#94a3b8;font-size:11px;">© 2026 Fortunato SCADA Platform · fortunato.ctech@gmail.com</p>
</td></tr>
</table></td></tr></table>
</body></html>`;
};

const isShelved = (alert) => {
  const until = alert.shelvedUntil;
  if (!until) return false;
  const ms = until.toMillis ? until.toMillis() : new Date(until).getTime();
  return ms > Date.now();
};

const cooldownActive = (alert) => {
  const minutes = alert.emailAlert?.cooldownMinutes ?? 60;
  const last    = alert.lastEmailAt;
  if (!last) return false;
  const lastMs  = last.toMillis ? last.toMillis() : new Date(last).getTime();
  return Date.now() - lastMs < minutes * 60 * 1000;
};

// Se invoca en cada RAISE (vía alertState.setEmailHook).
const onRaise = async (tenantId, sourceKey, alert) => {
  const emailAlert = alert.emailAlert;
  if (!emailAlert?.enabled || !emailAlert?.recipientUids?.length) return;
  if (isShelved(alert))     { console.log(`🔕 [emailNotifier] ${sourceKey} silenciada — sin email`); return; }
  if (cooldownActive(alert)) { console.log(`⏳ [emailNotifier] ${sourceKey} en cooldown`); return; }

  try {
    const uids      = emailAlert.recipientUids.slice(0, 10);
    const usersSnap = await db().collection('users')
      .where(admin.firestore.FieldPath.documentId(), 'in', uids)
      .get();

    const emails = usersSnap.docs.map(d => d.data().email).filter(Boolean);
    if (!emails.length) return;

    let machineName  = alert.machineId;
    let locationName = alert.locationId;
    let tenantName   = tenantId;

    try {
      const locDoc = await db()
        .collection('tenants').doc(tenantId)
        .collection('locations').doc(alert.locationId)
        .get();
      if (locDoc.exists) {
        const locData = locDoc.data();
        locationName  = locData.name ?? alert.locationId;
        const machine = (locData.layout?.machines ?? []).find(m => m.id === alert.machineId);
        if (machine) machineName = machine.name;
      }
      const tenantDoc = await db().collection('tenants').doc(tenantId).get();
      if (tenantDoc.exists) tenantName = tenantDoc.data().name ?? tenantId;
    } catch (e) {
      console.warn('[emailNotifier] enrich:', e.message);
    }

    const dateStr = new Date().toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
    const label   = alert.severity === 'fault' ? 'FALLA' : 'AVISO';

    await db().collection('email_trigger_queue').add({
      to:      emails,
      message: {
        subject: `[${label}] ${alert.title} — ${machineName}`,
        html:    buildEmailHtml({
          machineName, widgetTitle: alert.widgetTitle, severity: alert.severity,
          condition: alert.condition, value: alert.value, locationName, tenantName, dateStr,
        }),
      },
    });

    await alertState.markEmailSent(tenantId, sourceKey);
    console.log(`📧 [emailNotifier] mail enviado a ${emails.join(', ')}`);
  } catch (e) {
    console.error('[emailNotifier] error:', e.message);
  }
};

module.exports = { onRaise };
