import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sum } from '../src/math.js'

test('sum', () => {
  assert.equal(sum([1, 2, 3]), 6)
})
