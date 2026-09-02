const admin = require('firebase-admin');

const db = () => admin.firestore();

// Espejo del kill switch por máquina.
//
// Los documentos viven en
//   tenants/{t}/locations/{l}/automationPauses/{machineId}
// y los escribe el panel: es lo único que puede frenar una automatización, ya
// que estas ignoran el lock de operador a propósito.
//
// Se escucha con UN collectionGroup en vez de un listener por location: el
// motor ya abre uno por tenant para las reglas y otro para las máquinas, y
// sumar un tercero por cada ubicación no escala. El id del tenant y de la
// location salen del path del documento.
const paused = new Set();   // `${tenantId}/${locationId}/${machineId}`
let unsub = null;

const key = (tenantId, locationId, machineId) => `${tenantId}/${locationId}/${machineId}`;

// tenants/{t}/locations/{l}/automationPauses/{m} -> [t, l, m]
const idsFromPath = (ref) => {
  const p = ref.path.split('/');
  return { tenantId: p[1], locationId: p[3], machineId: p[5] };
};

const watch = async () => {
  unsub = db().collectionGroup('automationPauses').onSnapshot(snap => {
    snap.docChanges().forEach(change => {
      const { tenantId, locationId, machineId } = idsFromPath(change.doc.ref);
      const k = key(tenantId, locationId, machineId);
      // Reanudar es escribir paused:false, no borrar — pero si alguien borra el
      // documento igual se interpreta como "no pausado".
      if (change.type === 'removed' || change.doc.data().paused !== true) paused.delete(k);
      else paused.add(k);
    });
    console.log(`⏸️  [pauseRegistry] ${paused.size} equipo(s) con automatizaciones en pausa`);
  }, err => console.error('[pauseRegistry] onSnapshot:', err.message));

  console.log('🪞 [pauseRegistry] Kill switch sincronizado');
};

const isPaused = (tenantId, locationId, machineId) =>
  paused.has(key(tenantId, locationId, machineId));

const stop = () => { if (unsub) unsub(); };

module.exports = { watch, isPaused, stop };
