import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadUsers } from '../src/users.js'

test('loadUsers reads the seeded users', () => {
  assert.equal(loadUsers().length, 100)
})
