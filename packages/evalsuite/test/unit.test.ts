import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseDuration, resolveConfig } from '../src/config.ts'
import { normaliseVerdict } from '../src/judge/index.ts'
import { redactSecrets } from '../src/redact.ts'

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

test('redactSecrets masks secret-looking env values', () => {
  const env = { MY_API_KEY: 'sk-live-1234567890', HOME: '/home/someone-long' }
  const text = JSON.stringify({ a: 'token sk-live-1234567890 here', home: '/home/someone-long' })
  const out = redactSecrets(text, env)
  assert.doesNotMatch(out, /sk-live/)
  assert.match(out, /\[REDACTED\]/)
  assert.match(out, /someone-long/)
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
