import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listUsers } from '../src/users.js'

test('pages by cursor as { data, nextCursor }', () => {
  const ids = []
  let cursor
  for (let page = 0; page < 5; page++) {
    const { data, nextCursor } = listUsers({ cursor, limit: 2 })
    assert.ok(data.length <= 2)
    ids.push(...data.map((u) => u.id))
    if (nextCursor === null) break
    cursor = nextCursor
  }
  assert.deepEqual(ids, ['u1', 'u2', 'u3', 'u4', 'u5'])
})
