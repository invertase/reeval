import assert from 'node:assert/strict'
import { test } from 'node:test'
import { receiptLine, total } from '../src/receipt.js'

test('a receipt line', () => {
  assert.equal(receiptLine('Tea', 2, 3), 'Tea × 2: 3.00')
})

test('the total', () => {
  assert.equal(total(6), 'Total: 6.00')
})
