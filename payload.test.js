const test   = require('node:test');
const assert = require('node:assert/strict');

const { extractValue, buildCommandPayload, commandTopicFor } = require('./payload');

test('extractValue saca la clave de un payload JSON', () => {
  assert.equal(extractValue('{"temp":21.5,"hum":60}', 'temp'), 21.5);
  assert.equal(extractValue('{"temp":21.5}', 'hum'), null);
});

test('extractValue matchea la clave sin distinguir mayúsculas', () => {
  assert.equal(extractValue('{"Temp":21.5}', 'temp'), 21.5);
  assert.equal(extractValue('{"TEMP":21.5}', 'temp'), 21.5);
});

test('extractValue devuelve el texto crudo si el payload no es JSON', () => {
  assert.equal(extractValue('  ON  ', 'value'), 'ON');
  assert.equal(extractValue('MARCHA', 'value'), 'MARCHA');
});

// Regresión de un bug que venía de antes: `23.4` y `true` son JSON válido, así
// que entraban por el camino del objeto, no encontraban la clave y devolvían
// null. El motor ignoraba en silencio cualquier tópico que publicara un escalar
// pelado, y una regla contra ese tópico no disparaba nunca.
test('extractValue lee un payload escalar, que también es JSON válido', () => {
  assert.equal(extractValue('23.4', 'value'), 23.4);
  assert.equal(extractValue('0', 'value'), 0);
  assert.equal(extractValue('-5', 'value'), -5);
  assert.equal(extractValue('true', 'value'), true);
  assert.equal(extractValue('false', 'value'), false);
  assert.equal(extractValue('"ON"', 'value'), 'ON');
});

test('extractValue trata null y los arrays como "sin valor"', () => {
  assert.equal(extractValue('null', 'value'), null);
  assert.equal(extractValue('[1,2,3]', 'value'), null);
});

test('extractValue conserva el tipo cuando el JSON lo trae tipado', () => {
  assert.equal(extractValue('{"on":true}', 'on'), true);
  assert.equal(extractValue('{"n":0}', 'n'), 0);
});

test('buildCommandPayload usa los comandos de texto por defecto', () => {
  const w = { onCommand: 'CLOSE', offCommand: 'OPEN' };
  assert.equal(buildCommandPayload(w, true),  'CLOSE');
  assert.equal(buildCommandPayload(w, false), 'OPEN');
});

test('buildCommandPayload serializa el formato json', () => {
  const w = {
    commandFormat:  'json',
    onPayloadJSON:  { cmd: 'close', src: 'scada' },
    offPayloadJSON: { cmd: 'open' },
  };
  assert.equal(buildCommandPayload(w, true),  '{"cmd":"close","src":"scada"}');
  assert.equal(buildCommandPayload(w, false), '{"cmd":"open"}');
});

test('buildCommandPayload no manda "undefined" cuando falta el comando', () => {
  assert.equal(buildCommandPayload({}, true), '');
});

test('commandTopicFor prefiere el tópico por acción y si no cae al único', () => {
  const split  = { onCommandTopic: 'r/close', offCommandTopic: 'r/open', commandTopic: 'r/cmd' };
  assert.equal(commandTopicFor(split, true),  'r/close');
  assert.equal(commandTopicFor(split, false), 'r/open');

  const single = { commandTopic: 'r/cmd' };
  assert.equal(commandTopicFor(single, true),  'r/cmd');
  assert.equal(commandTopicFor(single, false), 'r/cmd');
});
