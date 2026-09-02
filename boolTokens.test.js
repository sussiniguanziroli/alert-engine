const test   = require('node:test');
const assert = require('node:assert/strict');

const { parseSwitchOn } = require('./boolTokens');
const fixture = require('./fixtures/switchTokens.fixture.json');

// Corre el MISMO fixture que el panel en
// iot-admin-panel/src/shared/utils/switchSemantics.test.js.
// Si las dos tablas de tokens divergen, uno de los dos falla.
test(`parseSwitchOn cumple los ${fixture.cases.length} casos del fixture compartido`, () => {
  for (const c of fixture.cases) {
    assert.equal(parseSwitchOn(c.in), c.on, `entrada ${JSON.stringify(c.in)}`);
  }
});

// undefined no se puede expresar en JSON, así que va aparte en ambos repos.
test('parseSwitchOn trata undefined como apagado', () => {
  assert.equal(parseSwitchOn(undefined), false);
});
