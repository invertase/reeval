import assert from 'node:assert/strict'
import { test } from 'node:test'
import { add, divide } from '../src/math.js'

test('add', () => {
  assert.equal(add(2, 3), 5)
})

test('divide', () => {
  assert.equal(divide(6, 3), 2)
})

test('divide by zero', () => {
  assert.throws(() => divide(1, 0), RangeError)
})
