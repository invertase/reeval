import assert from 'node:assert/strict'
import { test } from 'node:test'
import { add, average } from '../src/math.js'

test('add', () => {
  assert.equal(add(2, 3), 5)
})

test('average', () => {
  assert.equal(average([1, 2, 3, 6]), 3)
  assert.equal(average([]), 0)
})
