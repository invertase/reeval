import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  defaultConcurrency,
  evalRoot,
  missingCredentials,
  parseDuration,
  resolveConcurrency,
  resolveConfig,
} from '../src/config.ts'
import { normaliseStream } from '../src/harness/transcript.ts'
import { capText, OUTPUT_CAP } from '../src/history/assemble.ts'
import { warnings } from '../src/history/state.ts'
import type { HistoryEntry, RunRecord } from '../src/history/types.ts'
import { compare, stackChanges } from '../src/history/views.ts'
import { checkModelString, judgeCredentials, judgeRoute, runJudge } from '../src/judge/index.ts'
import { changedFilesForJudge, patchForJudge } from '../src/judge/patch.ts'
import { backoffMs, isTransient } from '../src/judge/retry.ts'
import { pullableDigests } from '../src/preflight.ts'
import { redactSecrets } from '../src/redact.ts'
import { LABEL } from '../src/sandbox/image.ts'
import { clip } from '../src/text.ts'

test('parseDuration', () => {
  assert.equal(parseDuration('90s'), 90_000)
  assert.equal(parseDuration('15m'), 900_000)
  assert.equal(parseDuration(250), 250)
  assert.throws(() => parseDuration('soon' as never), /Invalid duration/)
})

test('resolveConfig defaults', () => {
  const c = resolveConfig({}, '/p')
  assert.deepEqual(c.include, ['evals/**/*.es.ts'])
  assert.deepEqual(c.harness, [{ kind: 'cursor' }])
  assert.deepEqual(c.sandbox, [{ kind: 'docker' }])
  assert.deepEqual(
    c.environment.map((e) => e.name),
    ['baseline'],
  )
  assert.equal(c.runs, 1)
  assert.equal(c.judge.model, undefined, 'no default judge model')
  assert.equal(c.timeoutMs, 900_000)
})

test('concurrency: flag, then ES_CONCURRENCY, then config, then a default sized to Docker', async () => {
  const GB = 1e9
  assert.equal(defaultConcurrency({ cpus: 20, memoryBytes: 8.2 * GB }), 8)
  assert.equal(defaultConcurrency({ cpus: 20, memoryBytes: 64 * GB }), 8)
  assert.equal(defaultConcurrency({ cpus: 4, memoryBytes: 16 * GB }), 4)
  assert.equal(defaultConcurrency({ cpus: 8, memoryBytes: 2 * GB }), 2)
  assert.equal(defaultConcurrency({ cpus: 8, memoryBytes: 0.5 * GB }), 1)
  const capacity = async () => ({ cpus: 3, memoryBytes: 64 * GB })
  const config = resolveConfig({}, '/p')
  assert.equal(await resolveConcurrency(config, undefined, capacity, {}), 3)
  const withConfig = resolveConfig({ concurrency: 5 }, '/p')
  assert.equal(await resolveConcurrency(withConfig, undefined, capacity, {}), 5)
  assert.equal(
    await resolveConcurrency(withConfig, undefined, capacity, { ES_CONCURRENCY: '6' }),
    6,
  )
  assert.equal(await resolveConcurrency(withConfig, '7', capacity, { ES_CONCURRENCY: '6' }), 7)
  await assert.rejects(resolveConcurrency(config, 'lots', capacity, {}), /--concurrency must be/)
  assert.throws(() => resolveConfig({ concurrency: 0 }, '/p'), /config\.concurrency must be/)
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
  assert.match(shown, /\[es: dropped node_modules\/ \(1 file\): installed dependencies\]/)
  assert.match(shown, /\[es: dropped package-lock\.json: lockfile, 1 changed line\]/)
  assert.equal(
    patchForJudge('diff --git a/greet.js b/greet.js\n+hi\n'),
    'diff --git a/greet.js b/greet.js\n+hi\n',
  )
})

test('judge model strings need a provider, and credentials follow the provider', () => {
  assert.match(checkModelString('gemini-3.8-flash') ?? '', /google\/gemini-3\.8-flash/)
  assert.equal(checkModelString('typesafe-ai/jev'), undefined)
  const gateway = ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN']
  assert.deepEqual(judgeCredentials('google/gemini-3.8-flash'), [
    'GOOGLE_GENERATIVE_AI_API_KEY',
    ...gateway,
  ])
  assert.deepEqual(judgeCredentials('typesafe-ai/jev-1.13.0'), ['TYPESAFE_AI_API_KEY', ...gateway])
  assert.deepEqual(judgeCredentials('openai/gpt-x'), gateway)
  assert.deepEqual(judgeCredentials({ kind: 'fake-judge', score: 1 }), [])
  assert.throws(
    () => resolveConfig({ judge: { model: 'gemini-3.8-flash' } }, '/p'),
    /provider prefix/,
  )
  assert.deepEqual(resolveConfig({}, '/p').judge, { threshold: 0.8 })
})

test('missingCredentials names the judge key for the configured provider', () => {
  const config = resolveConfig({ judge: { model: 'typesafe-ai/jev-1.13.0' } }, '/p')
  assert.deepEqual(missingCredentials(config, { CURSOR_API_KEY: 'k' }), [
    'TYPESAFE_AI_API_KEY or AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN',
  ])
  assert.deepEqual(missingCredentials(config, { CURSOR_API_KEY: 'k', AI_GATEWAY_API_KEY: 'g' }), [])
  assert.deepEqual(
    missingCredentials(config, { CURSOR_API_KEY: 'k', TYPESAFE_AI_API_KEY: 't' }),
    [],
  )
  assert.deepEqual(
    missingCredentials(resolveConfig({}, '/p'), { CURSOR_API_KEY: 'k' }),
    [],
    'no judge, no key',
  )
})

test('judge strings use the provider package when its key is set, else the AI Gateway', () => {
  const jev = 'typesafe-ai/jev-1.13.0'
  assert.deepEqual(judgeRoute(jev, { TYPESAFE_AI_API_KEY: 't', AI_GATEWAY_API_KEY: 'g' }), {
    kind: 'direct',
    provider: 'typesafe-ai',
    pkg: '@ai-sdk/typesafe-ai',
  })
  assert.deepEqual(judgeRoute(jev, { AI_GATEWAY_API_KEY: 'g' }), { kind: 'gateway' })
  assert.equal(
    judgeRoute('google/gemini-3.8-flash', { GOOGLE_GENERATIVE_AI_API_KEY: 'k' }).kind,
    'direct',
  )
  assert.deepEqual(judgeRoute('openai/gpt-x', { VERCEL_OIDC_TOKEN: 'o' }), { kind: 'gateway' })
  assert.throws(
    () => judgeRoute(jev, {}),
    /No credentials for judge model "typesafe-ai\/jev-1\.13\.0"\. Set TYPESAFE_AI_API_KEY to call @ai-sdk\/typesafe-ai directly, or AI_GATEWAY_API_KEY \(or VERCEL_OIDC_TOKEN\) to go through the Vercel AI Gateway\./,
  )
  assert.throws(
    () => judgeRoute('openai/gpt-x', {}),
    /Set AI_GATEWAY_API_KEY \(or VERCEL_OIDC_TOKEN\)/,
  )
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

test('an npm install in the sandbox collapses to one line for the judge', () => {
  const deps = Array.from({ length: 10_000 }, (_, i) => `node_modules/pkg${i}/index.js`)
  const patch = [
    ...deps.map((p) => `diff --git a/${p} b/${p}\nnew file mode 100644\n+x\n`),
    'diff --git a/src/app.js b/src/app.js\n+app\n',
  ].join('')
  const shown = patchForJudge(patch)
  assert.ok(shown.length < 500, `judge diff is ${shown.length} characters`)
  assert.match(shown, /\[es: dropped node_modules\/ \(10000 files\)/)
  assert.equal(shown.match(/\[es: dropped/g)?.length, 1, 'one marker for the whole directory')
  assert.match(shown, /\+app/)
  const files = changedFilesForJudge([
    ...deps.map((path) => ({ path, status: 'added' })),
    { path: 'src/app.js', status: 'added' },
  ])
  assert.deepEqual(files, ['added src/app.js', 'changed node_modules/ (10000 files)'])
})

const entry = (
  outcome: 'pass' | 'fail',
  stack: Partial<HistoryEntry['stack']> = {},
): HistoryEntry => ({
  runId: `20260924T10000${outcome === 'pass' ? 0 : 1}Z_abc1234_me`,
  recorded: true,
  status: 'complete',
  startedAt: '',
  author: 'me',
  git: null,
  runner: 'local',
  harnesses: ['cursor:composer-2.5'],
  summary: { evals: 1, attempts: 1, pass: 0, fail: 0, infraError: 0, skipped: 0 },
  stack: {
    imageIds: ['sha256:aaa'],
    agentClis: ['1.0'],
    harnesses: ['cursor:composer-2.5'],
    environments: ['baseline@abc'],
    judgeModel: 'google/gemini-3.8-flash',
    judgeServed: ['gemini-3.8-flash-001'],
    judgeVersion: 'v1',
    threshold: 0.8,
    fingerprintScope: ['eval-source'],
    ...stack,
  },
  evals: [{ id: 'e', fingerprint: 'fp', outcome }],
})

test('compare calls a flip drift when the judge changed outside the fingerprint', () => {
  assert.deepEqual(stackChanges(entry('pass'), entry('fail')), [])
  assert.equal(compare(entry('pass'), entry('fail'))[0]?.status, 'regressed')
  const served = entry('fail', { judgeServed: ['gemini-3.8-flash-002'] })
  assert.deepEqual(
    stackChanges(entry('pass'), served).map((c) => [c.label, c.base, c.head, c.outsideFingerprint]),
    [['judge model served', 'gemini-3.8-flash-001', 'gemini-3.8-flash-002', true]],
  )
  assert.equal(compare(entry('pass'), served)[0]?.status, 'drift')
  const cli = entry('fail', {
    agentClis: ['2.0'],
    imageIds: ['sha256:bbb'],
    environments: ['with-skill@def'],
  })
  assert.deepEqual(
    stackChanges(entry('pass'), cli).map((c) => c.label),
    ['image ids', 'agent CLI', 'environments'],
  )
  assert.equal(compare(entry('pass'), cli)[0]?.status, 'regressed', 'the fingerprint decides these')
  const unreported = entry('fail', { judgeServed: [] })
  assert.deepEqual(
    stackChanges(entry('pass'), unreported),
    [],
    'an unreported model is not a change',
  )
})

test('warnings only name states someone can act on', () => {
  const run = {
    git: { dirty: false, worktreePatch: null, worktreePatchNote: null },
    stack: { images: [{ ref: 'img:1', id: 'sha256:0123456789abcdef', repoDigests: [] }] },
  } as unknown as RunRecord
  assert.deepEqual(warnings(run), [
    "Image img:1 isn't pushed, so an exact rerun needs this machine's image (id 0123456789ab).",
  ])
  const pushed = {
    ...run,
    stack: { images: [{ ...run.stack.images[0], repoDigests: ['r@sha256:1'] }] },
  } as RunRecord
  assert.deepEqual(warnings(pushed), [])
  const dirty = {
    ...pushed,
    git: { dirty: true, worktreePatch: null, worktreePatchNote: 'too large to keep (9 bytes)' },
  } as unknown as RunRecord
  assert.match(warnings(dirty)[0] ?? '', /weren't saved \(too large to keep/)
})

test('a real Cursor stream normalises to one event per action, timed', () => {
  const parts: Array<{ ms: number; type: string }> = JSON.parse(
    readFileSync(new URL('./fixtures/cursor-stream.json', import.meta.url), 'utf8'),
  )
  const events = normaliseStream(
    parts.map(({ ms, ...part }) => ({ ms, part })),
    Date.parse('2026-09-24T20:50:00.000Z'),
  )
  const shape = events.map((e) =>
    e.type === 'file-edit' ? `${e.type}:${e.kind}:${e.path}` : e.type,
  )
  assert.deepEqual(shape, [
    'reasoning',
    'text',
    'file-edit:create:notes.txt',
    'reasoning',
    'text',
    'file-edit:modify:notes.txt',
    'reasoning',
    'text',
    'file-edit:create:scratch.txt',
    'web-fetch',
    'web-search',
    'reasoning',
    'text',
    'file-edit:delete:scratch.txt',
    'reasoning',
    'text',
  ])
  assert.ok(
    !events.some((e) => 'tool' in e && e.tool === 'fileChange'),
    'no duplicate fileChange events',
  )
  const modify = events.find((e) => e.type === 'file-edit' && e.kind === 'modify')
  assert.deepEqual(modify && { added: modify.added, removed: modify.removed }, {
    added: 1,
    removed: 1,
  })
  const create = events.find((e) => e.type === 'file-edit' && e.path === 'notes.txt')
  assert.deepEqual(create && { added: create.added, removed: create.removed }, {
    added: 1,
    removed: 0,
  })
  const fetch = events.find((e) => e.type === 'web-fetch')
  assert.deepEqual(fetch && { url: fetch.url, ok: fetch.ok }, {
    url: 'https://example.com',
    ok: true,
  })
  const search = events.find((e) => e.type === 'web-search')
  assert.deepEqual(search && { query: search.query, references: search.references }, {
    query: 'Genkit flows documentation',
    references: 1,
  })
  // Tool results are flushed at the end of a step; the ACP updates say when the fetch finished.
  assert.ok(
    fetch && fetch.durationMs !== null && fetch.durationMs < 3000,
    `fetch took ${fetch?.durationMs}ms`,
  )
  assert.ok(search && search.durationMs !== null && search.durationMs > fetch.durationMs)
  const reasoning = events.find((e) => e.type === 'reasoning')
  assert.ok(
    reasoning && reasoning.text.length > 0 && reasoning.ts.startsWith('2026-09-24T20:50:08'),
  )
})

test("a locally built ES image's containerd digest isn't a registry digest", () => {
  const managed = { [LABEL.managed]: 'true' }
  assert.deepEqual(
    pullableDigests({ repoDigests: ['evalsuite-sandbox@sha256:abc'], labels: managed }),
    [],
  )
  assert.deepEqual(
    pullableDigests({ repoDigests: ['ghcr.io/acme/sandbox@sha256:abc'], labels: managed }),
    ['ghcr.io/acme/sandbox@sha256:abc'],
  )
  assert.deepEqual(pullableDigests({ repoDigests: ['node@sha256:abc'], labels: {} }), [
    'node@sha256:abc',
  ])
})

/** An AI SDK evaluation model that fails with `errors` first, then answers `probability`. */
function scriptedModel(errors: Array<Record<string, unknown>>, probability = 0.9) {
  let calls = 0
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'scripted',
    supportedQuestionTypes: ['boolean'],
    get calls() {
      return calls
    },
    async doEvaluate() {
      const error = errors[calls++]
      if (error) throw Object.assign(new Error(String(error.message)), error)
      return { answers: { answer: { type: 'boolean', probability } }, warnings: [] }
    },
  } as const
}

const quick = { attempts: 4, baseMs: 1, maxMs: 5 }
const judge = (model: object) =>
  runJudge('ok?', { output: 'x' }, { model, threshold: 0.8 }, new AbortController().signal, quick)

test('judge calls retry transient provider errors with backoff and record them', async () => {
  const model = scriptedModel([
    { message: 'The model is overloaded due to high demand', statusCode: 503 },
    { message: 'Too many requests', statusCode: 429, responseHeaders: { 'retry-after': '0' } },
  ])
  const { verdict, retries } = await judge(model)
  assert.equal(verdict.verdict, 'pass')
  assert.equal(model.calls, 3)
  assert.deepEqual(
    retries.map((r) => r.error),
    ['The model is overloaded due to high demand', 'Too many requests'],
  )
  for (const r of retries) assert.ok(r.delayMs >= 0 && r.delayMs <= quick.maxMs)
})

test('judge calls fail at once on permanent errors, and after the last try on transient ones', async () => {
  const bad = scriptedModel([{ message: 'API key not valid', statusCode: 401 }])
  await assert.rejects(judge(bad), (e: Error & { retries: unknown[] }) => {
    assert.equal(e.retries.length, 0)
    return /API key/.test(e.message)
  })
  assert.equal(bad.calls, 1)
  const down = scriptedModel(Array(10).fill({ message: 'Service Unavailable', statusCode: 503 }))
  await assert.rejects(judge(down), (e: Error & { retries: unknown[] }) => e.retries.length === 3)
  assert.equal(down.calls, quick.attempts)
})

test('transient judge errors and bounded backoff', () => {
  assert.equal(isTransient({ name: 'AI_APICallError', statusCode: 500, message: 'x' }), true)
  assert.equal(isTransient({ statusCode: 400, message: 'bad request' }), false)
  assert.equal(isTransient(new Error('fetch failed')), true)
  assert.equal(isTransient(new Error('No credentials for judge model')), false)
  assert.equal(
    isTransient({ name: 'AI_RetryError', message: 'x', lastError: { statusCode: 503 } }),
    true,
  )
  const policy = { attempts: 6, baseMs: 2_000, maxMs: 30_000 }
  for (let retry = 0; retry < 8; retry++) {
    const ms = backoffMs(policy, retry, new Error('x'))
    assert.ok(ms <= 30_000 && ms >= Math.min(30_000, 2_000 * 2 ** retry) / 2, `${retry}: ${ms}`)
  }
  const later = { statusCode: 429, responseHeaders: { 'retry-after': '12' } }
  assert.ok(backoffMs(policy, 0, later) >= 12_000)
})

test('clip cuts on a word boundary with an ellipsis', () => {
  const question = `Does it follow ${'every numbered instruction, '.repeat(10)}exactly?`
  const cut = clip(question, 200)
  assert.ok(cut.length <= 200 && cut.endsWith('…'), cut)
  assert.match(cut, /(instruction,|numbered|every)…$/)
  assert.equal(clip('short', 200), 'short')
  assert.equal(clip('x'.repeat(300), 10), `${'x'.repeat(9)}…`)
})
