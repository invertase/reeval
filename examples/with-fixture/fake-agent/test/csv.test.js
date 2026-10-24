import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parseCsv, stringifyCsv } from '../src/csv.js'

test('parseCsv', () => {
  assert.deepEqual(parseCsv('id,total\n1,12.50\n'), [{ id: '1', total: '12.50' }])
})

test('stringifyCsv round-trips data/people.csv', () => {
  const text = readFileSync('data/people.csv', 'utf8')
  assert.equal(stringifyCsv(parseCsv(text)), text)
})
