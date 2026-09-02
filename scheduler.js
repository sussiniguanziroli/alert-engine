const automationsCache = require('./automationsCache');
const automationEngine = require('./automationEngine');
const { matchesCron, lastDueWithin, DEFAULT_TIMEZONE } = require('./cronMatch');

// Disparos por horario.
//
// Un tick por minuto, alineado al segundo 0. No hace falta nada más fino: la
// resolución de las expresiones que genera el panel es el minuto.
//
// pm2 corre este servicio con `instances: 1, exec_mode: 'fork'`
// (ecosystem.config.js), así que no hay riesgo de que dos procesos disparen la
// misma automatización. Si algún día se pasa a cluster, esto necesita un lock.

const CATCH_UP_MINUTES = 15;

let timer = null;

const tickAt = (date) => {
  const entries = automationsCache.getScheduled();
  for (const entry of entries) {
    const tz = entry.timezone || DEFAULT_TIMEZONE;
    if (!matchesCron(entry.trigger.cron, date, tz)) continue;
    automationEngine.trigger(entry, `horario ${entry.trigger.cron} (${tz})`)
      .catch(e => console.error('[scheduler] trigger:', e.message));
  }
};

// Recuperación al arrancar. Si la VM estaba caída — o pm2 recargó — justo a la
// hora programada, esa corrida se perdería sin que nadie se entere. Para
// "arrancar la bomba a las 6" eso no es aceptable, así que al levantar se
// revisa si había una corrida vencida en los últimos CATCH_UP_MINUTES y si el
// último disparo registrado es anterior a ella.
const catchUp = async () => {
  const now     = new Date();
  const entries = automationsCache.getScheduled();
  let recovered = 0;

  for (const entry of entries) {
    const tz  = entry.timezone || DEFAULT_TIMEZONE;
    const due = lastDueWithin(entry.trigger.cron, now, tz, CATCH_UP_MINUTES);
    if (!due) continue;

    // Si ya corrió después de esa hora, no hay nada que recuperar. lastRunMs
    // viene de automationState, hidratado antes de llamar acá.
    const { lastRunMs } = automationEngine.getState(entry);
    if (lastRunMs >= due.getTime()) continue;

    const mins = Math.round((now.getTime() - due.getTime()) / 60000);
    console.log(`🕐 [scheduler] Recuperando "${entry.name}" — vencía hace ${mins} min`);
    await automationEngine
      .trigger(entry, `horario ${entry.trigger.cron} (${tz}) — recuperada ${mins} min tarde`)
      .catch(e => console.error('[scheduler] catchUp:', e.message));
    recovered++;
  }

  if (recovered) console.log(`🕐 [scheduler] ${recovered} corrida(s) recuperada(s)`);
};

const start = async () => {
  await catchUp();

  // Alinear al segundo 0 del próximo minuto para no quedar disparando a mitad
  // de minuto y arrastrar deriva.
  const msToNextMinute = 60000 - (Date.now() % 60000);
  setTimeout(() => {
    tickAt(new Date());
    timer = setInterval(() => tickAt(new Date()), 60000);
  }, msToNextMinute);

  console.log(`⏰ [scheduler] Iniciado — ${automationsCache.getScheduled().length} automatización(es) por horario`);
};

const stop = () => { if (timer) clearInterval(timer); };

module.exports = { start, stop, tickAt, catchUp, CATCH_UP_MINUTES };
