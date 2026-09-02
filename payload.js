// Lectura y armado de payloads MQTT. Estaba suelto dentro de index.js; ahora lo
// comparten el loop de mensajes, el cache de automatizaciones y el enviador de
// comandos, así que vive en un módulo propio y testeable.

// Saca el valor de una clave del payload.
//
// El caso escalar tenía un agujero que venía de antes: un payload como `23.4`
// o `true` es JSON VÁLIDO, así que entraba por el camino del objeto, no
// encontraba la clave y devolvía null — o sea que el motor ignoraba en silencio
// cualquier tópico que publicara un número pelado, y una regla configurada
// contra él no disparaba nunca. Solo funcionaban los payloads que hacían
// explotar a JSON.parse (`ON`, `MARCHA`), que caían al catch.
//
// Ahora un escalar se devuelve tal cual: si el JSON no es un objeto, el valor
// ES el payload y no hay ninguna clave que buscar.
const extractValue = (payloadStr, dataKey) => {
  let parsed;
  try {
    parsed = JSON.parse(payloadStr);
  } catch {
    // Ni siquiera es JSON: texto crudo.
    return payloadStr.trim();
  }

  if (parsed === null) return null;
  if (typeof parsed !== 'object') return parsed;      // number | boolean | string
  if (Array.isArray(parsed)) return null;             // no hay clave que buscar

  if (parsed[dataKey] !== undefined) return parsed[dataKey];
  const match = Object.keys(parsed).find(k => k.toLowerCase() === String(dataKey).toLowerCase());
  return match !== undefined ? parsed[match] : null;
};

// GEMELO de buildPayload/commandTopicFor en useMachineControls.js del panel: un
// comando automático tiene que salir EXACTAMENTE igual que el que manda una
// persona apretando el botón, o el equipo recibiría dos formatos distintos para
// la misma orden.
const buildCommandPayload = (widget, targetState) => {
  const payload = widget.commandFormat === 'json'
    ? (targetState ? widget.onPayloadJSON : widget.offPayloadJSON)
    : (targetState ? widget.onCommand     : widget.offCommand);
  return typeof payload === 'object' ? JSON.stringify(payload) : String(payload ?? '');
};

// Soporta tópicos separados por acción (NOJA: close/open, ProtOn/ProtOff…). Si
// no están definidos, cae al commandTopic único.
const commandTopicFor = (widget, targetState) =>
  (targetState ? widget.onCommandTopic : widget.offCommandTopic) || widget.commandTopic;

module.exports = { extractValue, buildCommandPayload, commandTopicFor };
