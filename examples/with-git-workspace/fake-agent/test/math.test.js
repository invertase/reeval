import assert from 'node:assert/strict'
import { test } from 'node:test'
import { add, subtract } from '../src/math.js'

test('add', () => {
  assert.equal(add(2, 3), 5)
})

test('subtract', () => {
  assert.equal(subtract(5, 3), 2)
})
