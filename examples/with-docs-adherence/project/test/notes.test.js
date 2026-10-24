import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getNote } from '../src/notes.js'

test('getNote finds a note', () => {
  assert.deepEqual(getNote('1'), { status: 200, body: { id: '1', text: 'Buy milk' } })
})

test('getNote reports a missing note', () => {
  assert.equal(getNote('9').status, 404)
  assert.equal(getNote('9').body.error.code, 'not_found')
})
