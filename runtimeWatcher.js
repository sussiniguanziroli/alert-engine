const automationsCache = require('./automationsCache');
const automationEngine = require('./automationEngine');

// Chequeo periódico de los disparos "por tiempo encendido" (trigger.kind ===
// 'runtime'): X minutos después de que un widget pasa de apagado a encendido,
// dispara la acción (típicamente, apagar).
//
// Separado de scheduler.js a propósito, aunque los dos laten cada minuto:
// scheduler.js dispara a una HORA FIJA con recuperación de corridas perdidas
// (catch-up basado en el reloj de pared); esto dispara según cuánto pasó
// desde un evento (el encendido), que automationEngine.applyRuntime ya sigue
// en tiempo real con cada mensaje MQTT. Este tick es solo la red de
// seguridad: agarra el caso de un equipo que reporta su estado poco seguido y
// por eso no llegó ningún mensaje nuevo justo cuando se cumplió la duración.
//
// pm2 corre este servicio con `instances: 1, exec_mode: 'fork'`
// (ecosystem.config.js), igual que scheduler.js — sin riesgo de doble disparo.

let timer = null;

const tick = () => {
  for (const entry of automationsCache.getRuntimeWatched()) {
    automationEngine.checkRuntime(entry)
      .catch(e => console.error('[runtimeWatcher] checkRuntime:', e.message));
  }
};

const start = () => {
  // Mismo alineado al segundo 0 del próximo minuto que scheduler.js, para que
  // los dos ticks (horario y tiempo-encendido) caigan juntos y sea más fácil
  // leer los logs en orden.
  const msToNextMinute = 60000 - (Date.now() % 60000);
  setTimeout(() => {
    tick();
    timer = setInterval(tick, 60000);
  }, msToNextMinute);

  console.log(`⏱️  [runtimeWatcher] Iniciado — ${automationsCache.getRuntimeWatched().length} automatización(es) por tiempo encendido`);
};

const stop = () => { if (timer) clearInterval(timer); };

module.exports = { start, stop, tick };
