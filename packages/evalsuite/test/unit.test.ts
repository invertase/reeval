import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evalRoot, missingCredentials, parseDuration, resolveConfig } from '../src/config.ts'
import { capText, OUTPUT_CAP } from '../src/history/assemble.ts'
import { checkModelString, judgeCredentials } from '../src/judge/index.ts'
import { patchForJudge } from '../src/judge/patch.ts'
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

test('judge prompt keeps source diffs and drops dependency noise', () => {
  const patch = [
    'diff --git a/node_modules/genkit/index.js b/node_modules/genkit/index.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/node_modules/genkit/index.js',
    '+module.exports = {}',
    'diff --git a/package-lock.json b/package-lock.json',
    '--- /dev/null',
    '+++ b/package-lock.json',
    '+{ "lock": true }',
    'diff --git a/src/index.js b/src/index.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/index.js',
    '+export const flow = () => ({ title: "Soup" })',
    '',
  ].join('\n')
  const shown = patchForJudge(patch)
  assert.match(shown, /src\/index\.js/)
  assert.match(shown, /title: "Soup"/)
  assert.doesNotMatch(shown, /module\.exports/)
  assert.doesNotMatch(shown, /"lock"/)
  assert.match(shown, /omitted 2 dependency or binary files/)
  assert.equal(
    patchForJudge('diff --git a/greet.js b/greet.js\n+hi\n'),
    'diff --git a/greet.js b/greet.js\n+hi\n',
  )
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

test('huge single outputs keep their head and tail, with a marker and hash', () => {
  const big = `${'a'.repeat(100_000)}${'m'.repeat(100_000)}${'z'.repeat(20_000)}`
  const capped = capText(big)
  assert.ok(capped.length < OUTPUT_CAP + 200)
  assert.ok(capped.startsWith('a'.repeat(1000)))
  assert.ok(capped.endsWith('z'.repeat(1000)))
  assert.match(capped, /\[es: truncated \d+ of 220000 characters, sha256 [0-9a-f]{64}\]/)
  assert.equal(capText('small'), 'small')
})

test('the history folder sits in the directory the evals live in', () => {
  assert.equal(evalRoot(['evals/**/*.es.ts']), 'evals')
  assert.equal(evalRoot(['test/evals/a/*.es.ts', 'test/evals/b/**/*.es.ts']), 'test/evals')
  assert.equal(evalRoot(['**/*.es.ts']), '')
  assert.equal(resolveConfig({}, '/p').history.dir, '/p/evals/.history')
  assert.equal(resolveConfig({ history: { dir: 'runs' } }, '/p').history.dir, '/p/runs')
  assert.equal(resolveConfig({}, '/p').record, 'ci')
  assert.throws(() => resolveConfig({ history: { artifacts: 'some' as 'all' } }, '/p'), /artifacts/)
})
