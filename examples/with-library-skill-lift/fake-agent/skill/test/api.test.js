import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listUsers } from '../src/api.js'

test('follows nextCursor to the last page', () => {
  let res = listUsers({ limit: '20' })
  const seen = [...res.body.data]
  while (res.body.nextCursor !== null) {
    res = listUsers({ limit: '20', cursor: res.body.nextCursor })
    seen.push(...res.body.data)
  }
  assert.equal(seen.length, 45)
})

test('rejects a bad cursor and a bad limit', () => {
  assert.equal(listUsers({ cursor: 'nope' }).body.error.code, 'invalid_cursor')
  assert.equal(listUsers({ limit: '0' }).body.error.code, 'invalid_limit')
})
