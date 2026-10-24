import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseDuration } from '../src/duration.js'

test('one unit', () => {
  assert.equal(parseDuration('45s'), 45_000)
  assert.equal(parseDuration('2m'), 120_000)
  assert.equal(parseDuration('1h'), 3_600_000)
})

test('several units add up', () => {
  assert.equal(parseDuration('1h30m'), 5_400_000)
  assert.equal(parseDuration('1m5s'), 65_000)
})

test('rejects what is not a duration', () => {
  assert.throws(() => parseDuration('soon'), /Not a duration/)
  assert.throws(() => parseDuration('10'), /Not a duration/)
})
