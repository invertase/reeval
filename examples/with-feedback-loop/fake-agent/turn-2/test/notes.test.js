import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listNotes } from '../src/notes.js'

test('ten notes a page, by cursor', () => {
  const first = listNotes()
  assert.equal(first.notes.length, 10)
  assert.equal(first.nextCursor, 'n10')
  assert.equal(listNotes({ cursor: 'n10' }).notes[0].id, 'n11')
})

test('nextCursor is null on the last page', () => {
  const last = listNotes({ cursor: 'n20' })
  assert.equal(last.notes.length, 5)
  assert.equal(last.nextCursor, null)
})
