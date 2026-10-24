import assert from 'node:assert/strict'
import { test } from 'node:test'
import { multiply } from '../src/math.js'

test('multiply multiplies', () => {
  assert.equal(multiply(2, 3), 6)
})

test('multiply refuses a string', () => {
  assert.throws(() => multiply('2', 3), TypeError)
  assert.throws(() => multiply(2, '3'), TypeError)
})
