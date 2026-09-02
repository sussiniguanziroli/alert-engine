// Disparo por horario, sin dependencias.
//
// El panel genera las expresiones con buildCron() y solo produce un subconjunto
// fijo: `m h * * dow`, con dow en `*` o una lista de días. Como controlamos los
// dos extremos, no hace falta una librería de cron entera — alcanza con
// evaluar ese subconjunto, y así el motor sigue con sus tres dependencias.
//
// La zona horaria NO es un detalle: la VM corre en UTC y las plantas están en
// Argentina. "Prender la bomba a las 6" sin convertir la arrancaría a las 3 de
// la mañana. Se resuelve con Intl.DateTimeFormat, que viene en Node y maneja
// DST correctamente — más confiable que restar un offset fijo.

const DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires';

// Los nombres cortos que devuelve Intl en 'en-US', mapeados al orden de cron
// (0 = domingo).
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const formatters = new Map();
const formatterFor = (timeZone) => {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12:  false,
      hour:    '2-digit',
      minute:  '2-digit',
      weekday: 'short',
    }));
  }
  return formatters.get(timeZone);
};

// Hora local de la planta para un instante dado.
const zonedParts = (date, timeZone = DEFAULT_TIMEZONE) => {
  let parts;
  try {
    parts = formatterFor(timeZone).formatToParts(date);
  } catch {
    // Timezone inválida en el documento de location: se cae al default en vez
    // de tirar y matar el tick del scheduler entero.
    parts = formatterFor(DEFAULT_TIMEZONE).formatToParts(date);
  }
  const get = (type) => parts.find(p => p.type === type)?.value;
  // 'en-US' con hour12:false devuelve 24 para la medianoche, no 0.
  const hour = Number(get('hour')) % 24;
  return { hour, minute: Number(get('minute')), dow: DOW[get('weekday')] };
};

// Mismo subconjunto que buildCron() del panel. Devuelve null si la expresión
// no es una de las que generamos: mejor no disparar que disparar mal.
const parseCron = (cron) => {
  if (typeof cron !== 'string') return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = parts;
  if (dom !== '*' || mon !== '*') return null;

  const minute = Number(m);
  const hour   = Number(h);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (!Number.isInteger(hour)   || hour   < 0 || hour   > 23) return null;

  let days = [];
  if (dow !== '*') {
    days = dow.split(',').map(Number);
    if (days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) return null;
  }
  return { hour, minute, days };
};

// ¿El instante `date` cae exactamente en el minuto programado?
const matchesCron = (cron, date, timeZone = DEFAULT_TIMEZONE) => {
  const spec = parseCron(cron);
  if (!spec) return false;
  const now = zonedParts(date, timeZone);
  if (now.hour !== spec.hour || now.minute !== spec.minute) return false;
  return spec.days.length === 0 || spec.days.includes(now.dow);
};

// Última vez que la expresión tendría que haber disparado dentro de los
// últimos `windowMinutes`, o null si no hubo ninguna.
//
// Existe para la recuperación al arrancar: si la VM estuvo caída a las 6:00 y
// pm2 la levanta 6:03, sin esto se pierde el arranque de una bomba sin que
// nadie se entere. Camina minuto a minuto hacia atrás — con una ventana de 15
// son 15 comparaciones, no vale la pena nada más astuto.
const lastDueWithin = (cron, now, timeZone = DEFAULT_TIMEZONE, windowMinutes = 15) => {
  if (!parseCron(cron)) return null;
  const base = new Date(now.getTime());
  base.setSeconds(0, 0);
  for (let i = 0; i <= windowMinutes; i++) {
    const t = new Date(base.getTime() - i * 60000);
    if (matchesCron(cron, t, timeZone)) return t;
  }
  return null;
};

module.exports = { DEFAULT_TIMEZONE, parseCron, zonedParts, matchesCron, lastDueWithin };
