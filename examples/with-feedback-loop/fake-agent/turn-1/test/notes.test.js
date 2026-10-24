import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listNotes } from '../src/notes.js'

test('ten notes a page', () => {
  assert.equal(listNotes().notes.length, 10)
  assert.equal(listNotes({ page: 3 }).notes.length, 5)
})
