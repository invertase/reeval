import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  defaultConcurrency,
  evalRoot,
  missingCredentials,
  parseDuration,
  resolveConcurrency,
  resolveConfig,
  selectProfile,
} from '../src/config.ts'
import { excludeMatcher, parseSkillMd, resolveEnvironment } from '../src/environment/resolve.ts'
import {
  DEFAULT_SKILL_EXCLUDE,
  defineEnvironment,
  isMovingRef,
  layered,
  parseGitRepo,
} from '../src/environment.ts'
import { AGENTS, agentAuth, brokeringFor } from '../src/harness/agents.ts'
import { normaliseStream } from '../src/harness/transcript.ts'
import { capText, OUTPUT_CAP } from '../src/history/assemble.ts'
import { warnings } from '../src/history/state.ts'
import type { HistoryEntry, RunRecord } from '../src/history/types.ts'
import { compare, stackChanges } from '../src/history/views.ts'
import { newRunId, RUN_ID } from '../src/ids.ts'
import { checkModelString, judgeCredentials, judgeRoute, runJudge } from '../src/judge/index.ts'
import { changedFilesForJudge, patchForJudge } from '../src/judge/patch.ts'
import { backoffMs, isTransient } from '../src/judge/retry.ts'
import { cascade, expand, type Resolved } from '../src/options.ts'
import { redactSecrets } from '../src/redact.ts'
import { createFakeSandbox } from '../src/sandbox/fake.ts'
import { clip } from '../src/text.ts'

test("a harness's auth is only its own credential, and a missing one fails closed", () => {
  const host = { CURSOR_API_KEY: 'crsr_k', AI_GATEWAY_API_KEY: 'gw_k', ANTHROPIC_API_KEY: 'sk-a' }
  assert.deepEqual(agentAuth(AGENTS.cursor, host), { CURSOR_API_KEY: 'crsr_k' })
  assert.throws(
    () => agentAuth(AGENTS.cursor, { AI_GATEWAY_API_KEY: 'gw_k' }),
    /^InfraError: CURSOR_API_KEY isn't set, so the Cursor harness can't authenticate/,
  )
  assert.deepEqual(brokeringFor({ kind: 'cursor' }), {
    credential: 'CURSOR_API_KEY',
    endpoints: AGENTS.cursor.endpoints,
  })
  assert.equal(brokeringFor({ kind: 'fake' }), undefined)
})

test('run ids sort by start time and differ for runs in the same second', () => {
  const start = new Date('2026-09-24T15:27:00.123Z')
  const a = newRunId(start, '009763c1234', 'elliot-hesp')
  const b = newRunId(start, '009763c1234', 'elliot-hesp')
  assert.match(a, /^20260924T152700Z_009763c_elliot-hesp_[0-9a-z]{4}$/)
  assert.match(a, RUN_ID)
  assert.notEqual(a, b, 'same second, commit and author: still two runs')
  assert.equal(newRunId(start, null, 'x', 'abcd'), '20260924T152700Z_nogit_x_abcd')
  const later = newRunId(new Date('2026-09-24T15:27:01Z'), null, 'a', '0000')
  assert.ok(later > newRunId(start, null, 'z', 'zzzz'), 'the stamp orders runs first')
})

test('the fake sandbox reads and writes ~/ paths in its home', async () => {
  const box = await createFakeSandbox({ kind: 'fake' })
  try {
    await box.writeFile('~/.config/es/hint.txt', 'from home')
    assert.equal(await box.readFile('~/.config/es/hint.txt'), 'from home')
    assert.equal(readFileSync(join(box.home, '.config/es/hint.txt'), 'utf8'), 'from home')
    assert.equal(await box.readFile('.config/es/hint.txt'), null, 'not in the workspace')
    assert.equal((await box.exec('cat ~/.config/es/hint.txt')).stdout, 'from home')
  } finally {
    await box.destroy()
  }
})

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
  assert.deepEqual(c.sandbox, { kind: 'docker' })
  assert.equal(c.environment, undefined, 'no environment by default')
  assert.deepEqual(c.profiles, {})
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
  summary: { evals: 1, attempts: 1, pass: 0, fail: 0, notGated: 0, infraError: 0, skipped: 0 },
  stack: {
    imageIds: ['sha256:aaa'],
    agentClis: ['1.0'],
    harnesses: ['cursor:composer-2.5'],
    environments: ['base@abc'],
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

const base: Resolved = {
  harness: [
    { kind: 'fake', id: 'a' },
    { kind: 'fake', id: 'b' },
  ],
  sandbox: { kind: 'fake' },
  environment: undefined,
  compare: undefined,
  runs: 3,
  env: {},
  judge: {},
  timeout: undefined,
  tags: [],
  pin: [],
}

test('expand: per harness, the control then each variant; labels name the role', () => {
  const skill = defineEnvironment('skill', { env: { A: '1' } })
  const { resolved } = cascade(base, [{ options: { compare: [skill], runs: 1 }, where: 'e' }], 'e')
  const attempts = expand(resolved)
  assert.deepEqual(
    attempts.map((a) => [a.cell.key, a.cell.role, a.gate !== 'none', a.label]),
    [
      ['a/-/fake', 'control', false, 'a · control'],
      ['a/skill/fake', 'variant', true, 'a · skill'],
      ['b/-/fake', 'control', false, 'b · control'],
      ['b/skill/fake', 'variant', true, 'b · skill'],
    ],
  )
})

test('cascade: profile defaults sit under evals, limits narrow unless pinned, --runs wins', () => {
  const skill = defineEnvironment('skill', {})
  const profile = {
    name: 'pr',
    reason: '--profile',
    defaults: { runs: 5 },
    limit: { runs: 1, compare: false as const, harness: ['a'] },
    judge: {},
    tags: [],
    budget: {},
  }
  const narrowed = cascade(base, [{ options: { compare: [skill] }, where: 'e' }], 'e', { profile })
  assert.equal(narrowed.resolved.runs, 1)
  assert.deepEqual(
    narrowed.resolved.harness.map((h) => h.id),
    ['a'],
  )
  assert.deepEqual(narrowed.resolved.compare?.variants, [])
  assert.deepEqual(narrowed.notes, [
    'runs 5 → 1 (profile pr)',
    'harnesses 2 → 1 (profile pr)',
    'compare off (profile pr)',
  ])
  const pinned = cascade(
    base,
    [{ options: { compare: [skill], pin: ['runs', 'compare'] }, where: 'e' }],
    'e',
    { profile, runs: 2 },
  )
  assert.equal(pinned.resolved.runs, 2, '--runs beats pins')
  assert.equal(pinned.resolved.compare?.variants.length, 1)
  const skipped = cascade(
    base,
    [{ options: { harness: { kind: 'fake', id: 'c' } }, where: 'e' }],
    'e',
    { profile },
  )
  assert.equal(skipped.skip, 'no harness left: profile pr allows a')
})

test('layered environments and overrides', async () => {
  const main = defineEnvironment('main', ({ secret }) => ({
    env: { KEY: secret.fromEnv('ES_UNIT_KEY', { optional: true }), MODE: 'main' },
    files: { 'a.txt': 'main' },
    setup: ['echo one'],
  }))
  const branch = main.extend('branch', { env: { MODE: 'branch' }, setup: ['echo two'] })
  const other = defineEnvironment('other', { files: { 'a.txt': 'other' }, rules: 'Be terse.' })
  const applied = layered(main, branch)
  assert.deepEqual(
    applied.layers.map((l) => l.name),
    ['main', 'branch'],
    'the variant layers skip what the control already has',
  )
  const r = await resolveEnvironment(applied, {}, '/p', 'e', 'AGENTS.md')
  assert.deepEqual(r.record.overrides, ['env.MODE'])
  assert.deepEqual(r.record.setup, ['echo one', 'echo two'])
  assert.deepEqual(r.record.unset, ['KEY'])
  assert.equal(r.vars.MODE, 'branch')
  const crossed = await resolveEnvironment(layered(main, other), {}, '/p', 'e', 'AGENTS.md')
  assert.deepEqual(crossed.record.overrides, ['files.a.txt'])
  assert.equal(crossed.record.parent, 'main')
  assert.ok(crossed.files.some((f) => f.path === 'AGENTS.md' && f.content === 'Be terse.'))
})

test('SKILL.md frontmatter is parsed as YAML', () => {
  const md = (front: string, body = 'Body.\n') => `---\n${front}\n---\n${body}`
  assert.deepEqual(parseSkillMd(md('name: greet\ndescription: Says hi'), 's'), {
    name: 'greet',
    description: 'Says hi',
    body: 'Body.\n',
  })
  assert.equal(
    parseSkillMd(md('description: |\n  Line one.\n  Line two.\nname: greet'), 's').description,
    'Line one.\nLine two.',
    'literal block keeps newlines',
  )
  assert.equal(
    parseSkillMd(md('description: >\n  Folded one\n  and two.\n'), 's').description,
    'Folded one and two.',
    'folded block joins lines',
  )
  assert.equal(parseSkillMd(md('description: |-\n  Kept.'), 's').description, 'Kept.')
  assert.equal(
    parseSkillMd(md(`description: "Use when: it's \\"quoted\\""`), 's').description,
    `Use when: it's "quoted"`,
  )
  assert.equal(parseSkillMd(md("description: 'It''s single'"), 's').description, "It's single")
  assert.equal(
    parseSkillMd(md('description: A plain scalar\n  that wraps.'), 's').description,
    'A plain scalar that wraps.',
  )
  assert.equal(
    parseSkillMd('---\r\nname: crlf\r\ndescription: |\r\n  Windows.\r\n---\r\nBody', 's')
      .description,
    'Windows.',
  )
  assert.deepEqual(parseSkillMd('No frontmatter.', 's'), { body: 'No frontmatter.' })
  assert.deepEqual(parseSkillMd('---\n---\nBody', 's'), {
    name: undefined,
    description: undefined,
    body: 'Body',
  })
  assert.equal(parseSkillMd(md('description: a---b'), 's').description, 'a---b')
  assert.throws(() => parseSkillMd(md('description: Use when: x'), 's'), /isn't valid YAML/)
  assert.throws(() => parseSkillMd(md('description: 42'), 's'), /must be a string/)
  assert.throws(() => parseSkillMd(md('- a list'), 's'), /must be a YAML mapping/)
})

test('excludeMatcher is gitignore-style', () => {
  const m = excludeMatcher(DEFAULT_SKILL_EXCLUDE)
  assert.equal(m('evals', true), true)
  assert.equal(m('evals', false), false, 'a trailing / matches directories only')
  assert.equal(m('references/evals', true), false, 'a leading / anchors to the skill root')
  assert.equal(m('.history', true), true)
  assert.equal(m('scripts/.history', true), true, 'an unanchored name matches at any depth')
  assert.equal(m('greet.es.ts', false), true)
  assert.equal(m('scripts/greet.es.ts', false), true)
  assert.equal(m('scripts/greet.ts', false), false)
  assert.equal(m('greetXes.ts', false), false, 'dots are literal')
  const custom = excludeMatcher(['drafts/*.md', 'secret.txt'])
  assert.equal(custom('drafts/a.md', false), true)
  assert.equal(custom('x/drafts/a.md', false), false, 'an inner / anchors too')
  assert.equal(custom('drafts/sub/a.md', false), false, '* stays within a name')
  assert.equal(custom('deep/secret.txt', false), true)
})

test('skill directories leave out eval material, recorded as excluded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'es-skill-'))
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  write(
    'skills/greet/SKILL.md',
    '---\nname: greet\ndescription: |\n  Greets.\n  Politely.\n---\nHi.',
  )
  write('skills/greet/references/tone.md', 'Warm.')
  write('skills/greet/references/evals/notes.md', 'Kept: only the root evals/ is eval material.')
  write('skills/greet/evals/evals.json', '{"prompts":["secret"]}')
  write('skills/greet/evals/.history/run.json', '{}')
  write('skills/greet/greet.es.ts', 'evaluate()')
  write('skills/greet/scripts/.history/x', 'x')
  write('skills/greet/.git/HEAD', 'ref: refs/heads/main')
  write('skills/greet/drafts/next.md', 'WIP')
  try {
    const env = (exclude?: string[]) =>
      defineEnvironment('e', ({ skill }) => ({
        skills: [skill.local(join(root, 'skills'), exclude ? { exclude } : {})],
      }))
    const r = await resolveEnvironment(layered(undefined, env()), {}, root, 'e', 'AGENTS.md')
    const [s] = r.skills
    assert.equal(s?.description, 'Greets.\nPolitely.')
    assert.deepEqual(
      s?.files.map((f) => f.path),
      ['drafts/next.md', 'references/evals/notes.md', 'references/tone.md'],
    )
    assert.deepEqual(r.record.skills[0]?.excluded, ['evals/', 'greet.es.ts', 'scripts/.history/'])

    const custom = await resolveEnvironment(
      layered(undefined, env([...DEFAULT_SKILL_EXCLUDE, 'drafts/'])),
      {},
      root,
      'e',
      'AGENTS.md',
    )
    assert.deepEqual(custom.record.skills[0]?.excluded, [
      'drafts/',
      'evals/',
      'greet.es.ts',
      'scripts/.history/',
    ])
    assert.notEqual(custom.record.skills[0]?.sha256, r.record.skills[0]?.sha256)

    const none = await resolveEnvironment(layered(undefined, env([])), {}, root, 'e', 'AGENTS.md')
    assert.deepEqual(none.record.skills[0]?.excluded, [], 'an empty list replaces the defaults')
    assert.ok(none.skills[0]?.files.some((f) => f.path === 'evals/evals.json'))
    assert.ok(!none.skills[0]?.files.some((f) => f.path.startsWith('.git/')), '.git always goes')

    writeFileSync(join(root, 'skills/greet/evals/evals.json'), '{"prompts":["changed"]}')
    const edited = await resolveEnvironment(layered(undefined, env()), {}, root, 'e', 'AGENTS.md')
    assert.equal(edited.record.digest, r.record.digest, 'editing evals keeps the fingerprint')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  assert.throws(
    () =>
      defineEnvironment('bad', ({ skill }) => ({ skills: [skill.local('.', { exclude: ['/'] })] })),
    /skill exclude must be an array of paths or globs/,
  )
})

test('git refs and repo shorthands', () => {
  assert.equal(isMovingRef('main'), true)
  assert.equal(isMovingRef(undefined), true)
  assert.equal(isMovingRef('feature/x'), true)
  assert.equal(isMovingRef('v2.4.0'), false)
  assert.equal(isMovingRef('0.3.0'), false)
  assert.equal(isMovingRef('a1b2c3d'), false)
  assert.deepEqual(parseGitRepo('github:invertase/genkit-skills'), {
    url: 'https://github.com/invertase/genkit-skills.git',
  })
  assert.deepEqual(parseGitRepo('https://github.com/invertase/skills/tree/v1/skills/genkit'), {
    url: 'https://github.com/invertase/skills.git',
    ref: 'v1',
    path: 'skills/genkit',
  })
})

test('selectProfile: --profile, then ES_PROFILE, then defaultProfile', () => {
  const config = resolveConfig(
    {
      budget: { attempts: 50 },
      defaultProfile: { ci: 'pr', local: 'dev' },
      profiles: { pr: { budget: { duration: '1h' } }, dev: {}, nightly: { record: 'always' } },
    },
    '/p',
  )
  assert.equal(selectProfile(config, 'nightly', {})?.reason, '--profile')
  assert.equal(selectProfile(config, undefined, { ES_PROFILE: 'nightly' })?.name, 'nightly')
  const ci = selectProfile(config, undefined, { CI: 'true' })
  assert.deepEqual(
    [ci?.name, ci?.reason, ci?.budget],
    ['pr', 'auto: CI is set', { attempts: 50, duration: '1h' }],
  )
  assert.equal(selectProfile(config, undefined, {})?.reason, 'default')
  assert.throws(
    () => selectProfile(config, 'nope', {}),
    /Unknown profile "nope"\. Profiles in es\.config\.ts: pr, dev, nightly\./,
  )
})
