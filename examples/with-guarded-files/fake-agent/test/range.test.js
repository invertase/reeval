import assert from 'node:assert/strict'
import { test } from 'node:test'
import { range } from '../src/range.js'

test('range(3) is 0, 1, 2, 3', () => {
  assert.deepEqual(range(3), [0, 1, 2, 3])
})
