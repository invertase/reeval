import assert from 'node:assert/strict'
import { test } from 'node:test'
import { price } from '../src/price.js'

test('price', () => {
  assert.match(price(1250), /^[A-Z]{3} 12\.50$/)
})
