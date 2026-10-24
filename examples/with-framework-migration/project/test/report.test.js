const assert = require('node:assert/strict')
const { test } = require('node:test')
const { report } = require('../src/report.js')
const { toCelsius, toFahrenheit } = require('../src/temperature.js')

test('converts both ways', () => {
  assert.equal(toFahrenheit(100), 212)
  assert.equal(toCelsius(32), 0)
})

test('reports a city', () => {
  assert.equal(report('Lisbon', 20), 'Lisbon: 20°C (68°F)')
})
