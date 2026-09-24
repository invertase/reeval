import assert from 'node:assert/strict'
import { test } from 'node:test'
import { missingCredentials, parseDuration, resolveConfig } from '../src/config.ts'
import { checkModelString, judgeCredentials } from '../src/judge/index.ts'
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

test('judge model strings need a provider, and credentials follow the provider', () => {
  assert.match(checkModelString('gemini-3.8-flash') ?? '', /google\/gemini-3\.8-flash/)
  assert.equal(checkModelString('typesafe-ai/jev'), undefined)
  assert.deepEqual(judgeCredentials('google/gemini-3.8-flash'), ['GOOGLE_GENERATIVE_AI_API_KEY'])
  assert.deepEqual(judgeCredentials('typesafe-ai/jev'), ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN'])
  assert.deepEqual(judgeCredentials({ kind: 'fake-judge', score: 1 }), [])
  assert.throws(
    () => resolveConfig({ judge: { model: 'gemini-3.8-flash' } }, '/p'),
    /provider prefix/,
  )
  assert.deepEqual(resolveConfig({}, '/p').judge, {
    model: 'google/gemini-3.8-flash',
    threshold: 0.8,
  })
})

test('missingCredentials names the judge key for the configured provider', () => {
  const config = resolveConfig({ judge: { model: 'typesafe-ai/jev' } }, '/p')
  assert.deepEqual(missingCredentials(config, { CURSOR_API_KEY: 'k' }), [
    'AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN',
  ])
  assert.deepEqual(missingCredentials(config, { CURSOR_API_KEY: 'k', AI_GATEWAY_API_KEY: 'g' }), [])
})
