const test   = require('node:test');
const assert = require('node:assert/strict');

const { evaluate } = require('./evaluator');

// evaluate() decide si una alarma se dispara, y hasta ahora no tenía un solo
// test. Con las automatizaciones pasa además a poder accionar equipamiento
// físico, así que su comportamiento en los bordes deja de ser un detalle.

test('comparadores numéricos', () => {
  assert.equal(evaluate(12, '>',  10), true);
  assert.equal(evaluate(10, '>',  10), false);
  assert.equal(evaluate(9,  '<',  10), true);
  assert.equal(evaluate(10, '>=', 10), true);
  assert.equal(evaluate(10, '<=', 10), true);
  assert.equal(evaluate(10, '==', 10), true);
  assert.equal(evaluate(10, '!=', 10), false);
  assert.equal(evaluate(11, '!=', 10), true);
});

test('acepta strings numéricos, que es como llegan del payload MQTT', () => {
  assert.equal(evaluate('12.5', '>', '10'),  true);
  assert.equal(evaluate('9.99', '>', '10'),  false);
  assert.equal(evaluate('-5',   '<', '0'),   true);
  assert.equal(evaluate('1e3',  '>', '999'), true);
});

// Falla cerrado: ante un valor no numérico NO dispara. Importa para las
// automatizaciones — un sensor que empieza a mandar basura no debería terminar
// accionando un equipo.
test('falla cerrado ante valores no numéricos', () => {
  assert.equal(evaluate('abc',     '>', 10),    false);
  assert.equal(evaluate(null,      '>', 10),    false);
  assert.equal(evaluate(undefined, '>', 10),    false);
  assert.equal(evaluate('',        '>', 10),    false);
  assert.equal(evaluate(10,        '>', 'abc'), false);
  assert.equal(evaluate('ON',      '>', 10),    false);
});

test('operador desconocido no dispara', () => {
  assert.equal(evaluate(50, '≥',       10), false);
  assert.equal(evaluate(50, '',        10), false);
  assert.equal(evaluate(50, undefined, 10), false);
  assert.equal(evaluate(50, '=',       50), false);
});

// Comportamiento heredado de parseFloat que conviene tener documentado: un
// payload con la unidad pegada se lee igual, tomando el prefijo numérico.
test('parseFloat toma el prefijo numérico de un valor con unidad', () => {
  assert.equal(evaluate('12.5degC', '>', '10'),  true);
  assert.equal(evaluate('220V',     '>', '200'), true);
});

// La igualdad se hace sobre floats, así que arrastra la precisión de IEEE-754.
test('la igualdad compara floats, no texto', () => {
  assert.equal(evaluate('10.0', '==', '10'), true);
  assert.equal(evaluate(0.1 + 0.2, '==', 0.3), false);
});
