import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseDuration, resolveConfig } from '../src/config.ts'
import { normaliseVerdict } from '../src/judge/index.ts'

test('parseDuration', () => {
  assert.equal(parseDuration('90s'), 90_000)
  assert.equal(parseDuration('15m'), 900_000)
  assert.equal(parseDuration(250), 250)
  assert.throws(() => parseDuration('soon' as never), /Invalid duration/)
})

test('resolveConfig defaults', () => {
  const c = resolveConfig({}, '/p')
  assert.deepEqual(c.include, ['evals/**/*.es.ts'])
  assert.equal(c.harness.kind, 'cursor')
  assert.equal(c.sandbox.kind, 'docker')
  assert.equal(c.timeoutMs, 900_000)
})

test('verdicts without evidence become inconclusive', () => {
  assert.equal(
    normaliseVerdict({ verdict: 'pass', reason: 'r', evidence: [' '] }).verdict,
    'inconclusive',
  )
  assert.equal(
    normaliseVerdict({ verdict: 'fail', reason: 'r', evidence: [] }).verdict,
    'inconclusive',
  )
  assert.equal(normaliseVerdict({ verdict: 'pass', reason: 'r', evidence: ['x'] }).verdict, 'pass')
})
