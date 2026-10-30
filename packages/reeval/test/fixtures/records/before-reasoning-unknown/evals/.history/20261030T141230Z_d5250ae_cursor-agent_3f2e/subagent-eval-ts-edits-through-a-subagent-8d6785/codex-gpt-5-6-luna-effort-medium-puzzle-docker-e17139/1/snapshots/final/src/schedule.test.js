import { test } from 'node:test'
import assert from 'node:assert/strict'
import { maxMeetings } from './schedule.js'
test('max meetings', () => {
  assert.equal(maxMeetings([[1, 3], [2, 4], [3, 5], [6, 7]]), 3)
  assert.equal(maxMeetings([]), 0)
  assert.equal(maxMeetings([[1, 10], [2, 3], [4, 5], [6, 7]]), 3)
})
