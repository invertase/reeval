import assert from 'node:assert/strict'
import { test } from 'node:test'
import { median } from '../src/stats.js'

test('median of an odd count', () => {
  assert.equal(median([3, 1, 2]), 2)
})

test('median of an even count', () => {
  assert.equal(median([4, 1, 3, 2]), 2.5)
})

test('median of numbers with more than one digit', () => {
  assert.equal(median([10, 9, 2]), 9)
})
