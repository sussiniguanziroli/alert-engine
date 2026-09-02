// Semántica booleana de estado, para el readback de comandos automáticos:
// dado el valor que publica el equipo en su tópico de estado, decidir si eso
// significa "encendido".
//
// GEMELO EXACTO de parseSwitchOn en el panel:
//   iot-admin-panel/src/features/dashboard/hooks/useMachineControls.js
//
// La tabla está duplicada a propósito y no en un paquete compartido: son veinte
// líneas, los dos repos se despliegan por caminos distintos (el panel a
// hosting, esto por git pull en la VM) y una dependencia publicada entre ambos
// costaría más de lo que resuelve. Lo que evita que la duplicación derive en
// silencio es fixtures/switchTokens.fixture.json, que existe igual en los dos
// lados y contra el que corren los tests de ambos: si alguien agrega un token
// de un lado y no del otro, falla un test, no un equipo en la planta.
const BOOL_ON = new Set(['ON', '1', 'TRUE', 'HIGH', 'MARCHA', 'ACTIVE', 'CLOSED', 'START', 'ALARM', 'FAULT']);

// Acepta lo que devuelva extractValue: string del payload crudo, o number /
// boolean si el payload era JSON y la clave venía tipada.
const parseSwitchOn = (v) => BOOL_ON.has(String(v).toUpperCase().trim());

module.exports = { BOOL_ON, parseSwitchOn };
