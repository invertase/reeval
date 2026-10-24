import assert from 'node:assert/strict'
import { test } from 'node:test'
import { divide } from '../src/math.js'

test('divide', () => {
  assert.equal(divide(6, 3), 2)
  assert.throws(() => divide(1, 0), { name: 'RangeError', message: 'b must not be 0' })
})
