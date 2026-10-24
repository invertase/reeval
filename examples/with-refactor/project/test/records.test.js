import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseOrder } from '../src/orders.js'
import { parseUser } from '../src/users.js'

test('parseUser', () => {
  assert.deepEqual(parseUser('id=1;name=Ada;email=ada@example.com'), {
    id: 1,
    name: 'Ada',
    email: 'ada@example.com',
  })
})

test('parseOrder', () => {
  assert.deepEqual(parseOrder('id=7; user=1; total=12.50;'), { id: 7, user: 1, total: 12.5 })
})

test('a value may contain =', () => {
  assert.equal(parseUser('id=2;name=a=b;email=x').name, 'a=b')
})
