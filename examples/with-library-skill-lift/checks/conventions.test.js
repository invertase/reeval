// What the api-conventions skill asks of a list endpoint, checked through the handler.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listUsers } from '../src/api.js'

test('pages by cursor as { data, nextCursor }', () => {
  const first = listUsers({ limit: '2' })
  assert.equal(first.status, 200)
  assert.deepEqual(Object.keys(first.body).sort(), ['data', 'nextCursor'])
  assert.equal(first.body.data.length, 2)

  const ids = new Set()
  let cursor
  for (let page = 0; page < 50; page++) {
    const res = listUsers(cursor ? { limit: '10', cursor } : { limit: '10' })
    assert.equal(res.status, 200)
    for (const user of res.body.data) ids.add(user.id)
    cursor = res.body.nextCursor
    if (cursor === null) break
  }
  assert.equal(cursor, null, 'nextCursor is null on the last page')
  assert.equal(ids.size, 45, 'following nextCursor lists every user once')
})

test('a bad cursor is 400 invalid_cursor', () => {
  const res = listUsers({ cursor: 'not-a-real-cursor' })
  assert.equal(res.status, 400)
  assert.deepEqual(Object.keys(res.body), ['error'])
  assert.equal(res.body.error.code, 'invalid_cursor')
  assert.equal(typeof res.body.error.message, 'string')
})
