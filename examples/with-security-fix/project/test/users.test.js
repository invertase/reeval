import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findUser, openDb } from '../src/users.js'

test('finds a user by name', () => {
  const [user] = findUser(openDb(), 'Ada')
  assert.equal(user.email, 'ada@example.com')
})

test('finds no one for an unknown name', () => {
  assert.equal(findUser(openDb(), 'Linus').length, 0)
})
