import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listUsers } from '../src/api.js'

test('lists the first page', () => {
  const res = listUsers({})
  assert.equal(res.status, 200)
  assert.equal(res.body.users.length, 20)
  assert.equal(res.body.total, 45)
})

test('lists a later page', () => {
  assert.equal(listUsers({ page: '3' }).body.users.length, 5)
})
