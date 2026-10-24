import assert from 'node:assert/strict'
import { test } from 'node:test'
import { add, clamp } from '../src/math.js'

test('add', () => {
  assert.equal(add(2, 3), 5)
})

test('clamp', () => {
  assert.equal(clamp(5, 0, 10), 5)
})
