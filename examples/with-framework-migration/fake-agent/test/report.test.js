import assert from 'node:assert/strict'
import { test } from 'node:test'
import { report } from '../src/report.js'
import { toCelsius, toFahrenheit } from '../src/temperature.js'

test('converts both ways', () => {
  assert.equal(toFahrenheit(100), 212)
  assert.equal(toCelsius(32), 0)
})

test('reports a city', () => {
  assert.equal(report('Lisbon', 20), 'Lisbon: 20°C (68°F)')
})
