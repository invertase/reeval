import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCsv } from '../src/csv.js'

test('parseCsv', () => {
  assert.deepEqual(parseCsv('id,total\n1,12.50\n'), [{ id: '1', total: '12.50' }])
})
