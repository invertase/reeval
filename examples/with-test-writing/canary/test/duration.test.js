import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseDuration } from '../src/duration.js'

test('parses a duration', () => {
  assert.equal(parseDuration('45s'), 45_000)
})
