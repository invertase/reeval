// One matcher table (src/matchers.ts) for both ways a matcher is called: the published `Matchers`
// interface names exactly its rows, and the attempt protocol's `expect` call (src/attempt/match.ts)
// answers every matcher as the TypeScript `expect` records it.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { type ExpectCall, fromWire, match } from '../src/attempt/match.ts'
import {
  attemptAssertions,
  createExpect,
  type ExpectTask,
  extendExpect,
} from '../src/engine/expect.ts'
import { MATCHERS, matchers } from '../src/matchers.ts'
import type { AttemptContext, TranscriptEvent, Verdict } from '../src/types.ts'
import { pkgRoot } from './helpers.ts'

extendExpect(matchers)

const at = { ts: '2026-10-18T10:00:00.000Z', atMs: 0, durationMs: 1 }

const tool = (name: string, input: unknown): TranscriptEvent => ({
  ...at,
  type: 'tool',
  toolCallId: `call_${name}`,
  tool: name,
  input,
  output: 'ok',
  ok: true,
})

const files: Record<string, string> = { 'greet.js': 'export const greet = () => "hi"\n' }

const turn = {
  prompt: 'p',
  text: 'done',
  transcript: [
    tool('shell', { command: 'npm test' }),
    tool('read', { path: '.agents/skills/greet/SKILL.md' }),
    tool('mcp__docs__search', { query: 'greet' }),
    {
      ...at,
      type: 'file-edit',
      toolCallId: 'e',
      path: 'greet.js',
      kind: 'create',
      added: 1,
      removed: 0,
    },
    { ...at, type: 'web-search', toolCallId: 's', query: 'greeting etiquette', references: 1 },
  ] as TranscriptEvent[],
  unreported: ['web-fetch'] as Array<'web-search' | 'web-fetch'>,
  diff: { patch: '', files: [{ path: 'src/greet.js', status: 'added' as const }] },
  readFile: async (path: string) => files[path] ?? null,
}

const c = {
  turns: [turn],
  exec: async (command: string) =>
    command === 'true'
      ? { exitCode: 0, stdout: 'ok\n', stderr: '' }
      : { exitCode: 1, stdout: '', stderr: 'boom\n' },
  readFile: async (path: string) => files[path] ?? null,
} as unknown as AttemptContext

const verdict: Verdict = {
  verdict: 'fail',
  score: 0.3,
  threshold: 0.8,
  question: 'Is it polite?',
  model: 'fake/judge',
}

const re = (regexp: string, flags?: string) => ({ regexp, ...(flags ? { flags } : {}) })

/** Each row: the protocol call's subject and wire arguments; every row runs with and without `.not`. */
const CASES: Array<[keyof typeof MATCHERS, ExpectCall['subject'], unknown[]]> = [
  ['toHaveFile', { attempt: true }, ['greet.js', re('greet')]],
  ['toHaveFile', { turn: 0 }, ['greet.js', 'nope']],
  ['toHaveFile', { attempt: true }, ['missing.js']],
  ['toSucceed', { exec: 'true' }, []],
  ['toSucceed', { exec: 'false' }, []],
  ['toHaveSearched', { turn: 0 }, [re('etiquette$')]],
  ['toHaveFetched', { turn: 0 }, ['example.com']],
  ['toHaveCalledSkill', { attempt: true }, ['greet']],
  ['toHaveCalledMcp', { turn: 0 }, ['docs', 'search', { query: re('^gr') }]],
  ['toHaveCalledTool', { turn: 0 }, [re('^sh'), 'npm']],
  ['toHaveRun', { turn: 0 }, [re('npm (run )?test', 'i')]],
  ['toHaveRun', { attempt: true }, ['pnpm']],
  ['toHaveEdited', { turn: 0 }, ['greet.js']],
  ['toHaveChanged', { attempt: true }, [['src', re('\\.md$')]]],
  ['toHaveChanged', { turn: 0 }, ['docs']],
  ['toPass', { value: verdict as never }, []],
  ['toPass', { value: { ...verdict, verdict: 'pass', score: 0.9 } as never }, []],
  ['toPass', { value: { nope: true } }, []],
]

/** The subject as an eval's body hands it to `expect`. */
const tsSubject = (subject: ExpectCall['subject']): unknown =>
  'turn' in subject
    ? turn
    : 'attempt' in subject
      ? c
      : 'value' in subject
        ? subject.value
        : 'exec' in subject
          ? c.exec(subject.exec)
          : c.readFile(subject.readFile)

const task = (): ExpectTask => ({ type: 'test', name: 't', fullTestName: 'file > t' })

describe('one matcher table', () => {
  test("the published Matchers interface names exactly the table's matchers", () => {
    const dist = join(pkgRoot, 'dist')
    const declaration = readdirSync(dist)
      .filter((f) => f.endsWith('.d.ts'))
      .map((f) => readFileSync(join(dist, f), 'utf8'))
      .find((text) => text.includes('interface Matchers<'))
    assert.ok(declaration, 'a .d.ts in dist/ declares the Matchers interface')
    const body = declaration.slice(declaration.indexOf('interface Matchers<')).split('\n  }\n')[0]
    const names = [...(body ?? '').matchAll(/^ {4}(\w+)\(/gm)].map((m) => m[1])
    assert.deepEqual(names, Object.keys(MATCHERS))
  })

  test('every matcher answers a protocol call as the TypeScript expect records it', async () => {
    assert.deepEqual(
      [...new Set(CASES.map(([name]) => name))].sort(),
      Object.keys(MATCHERS).sort(),
      'a case for every matcher',
    )
    const statuses = new Set<string>()
    for (const [matcher, subject, args] of CASES) {
      for (const not of [false, true]) {
        const t = task()
        const own = createExpect(t)
        const chain = own(tsSubject(subject)) as unknown as Record<string, unknown>
        const assertion = (not ? chain.not : chain) as Record<string, (...a: unknown[]) => unknown>
        await Promise.resolve()
          .then(() => assertion[matcher]?.(...args.map(fromWire)))
          .catch(() => {})
        const [recorded] = attemptAssertions(t)
        const call = { op: 'expect', subject, matcher, args, not, soft: false } as ExpectCall
        const outcome = await match(c, call)
        const where = `${not ? 'not.' : ''}${matcher}(${JSON.stringify(args)})`
        assert.deepEqual(
          outcome,
          {
            status: recorded?.status,
            ...(recorded?.message === undefined ? {} : { message: recorded.message }),
          },
          where,
        )
        statuses.add(outcome.status)
      }
    }
    assert.deepEqual([...statuses].sort(), ['error', 'fail', 'pass'])
  })

  test('a polled call re-reads its subject until the matcher passes, or answers its last try', async () => {
    let reads = 0
    const later = {
      ...c,
      readFile: async (path: string) => (++reads >= 3 ? (files[path] ?? null) : null),
    } as unknown as AttemptContext
    const call: ExpectCall = {
      op: 'expect',
      subject: { attempt: true },
      matcher: 'toHaveFile',
      args: ['greet.js'],
      not: false,
      soft: false,
      poll: { interval: 5, timeout: 1000 },
    }
    assert.deepEqual(await match(later, call), { status: 'pass' })
    assert.equal(reads, 3)
    const never = await match(c, {
      ...call,
      args: ['missing.js'],
      poll: { interval: 5, timeout: 30 },
    })
    assert.deepEqual(never, { status: 'fail', message: 'expected file missing.js to exist' })
    assert.deepEqual(await match(c, { ...call, poll: {} }), { status: 'pass' })
  })

  test("a call reeval can't evaluate is a usage error naming what's wrong", async () => {
    const call: ExpectCall = {
      op: 'expect',
      subject: { turn: 0 },
      matcher: 'toHaveRun',
      args: [],
      not: false,
      soft: false,
    }
    await assert.rejects(match(c, { ...call, matcher: 'toBe' }), {
      name: 'UsageError',
      message: /^toBe isn't one of reeval's matchers \(toHaveFile, toSucceed, /,
    })
    await assert.rejects(match(c, { ...call, args: [re('(')] }), {
      name: 'UsageError',
      message: /^\{"regexp":"\("\} isn't a regular expression: /,
    })
    await assert.rejects(match(c, { ...call, subject: { turn: 1 } }), {
      name: 'UsageError',
      message: "expect's subject is turn 1, but the attempt has 1 turn",
    })
    const none = { ...c, turns: [] } as unknown as AttemptContext
    await assert.rejects(match(none, call), { message: /the attempt has 0 turns$/ })
    const broken = {
      ...c,
      readFile: async () => {
        throw new Error('sandbox gone')
      },
    } as unknown as AttemptContext
    await assert.rejects(
      match(broken, { ...call, subject: { readFile: 'a' }, matcher: 'toHaveFile', args: ['a'] }),
      { message: 'sandbox gone' },
    )
  })

  test('wire arguments become the values expect takes, patterns at any depth', () => {
    assert.deepEqual(fromWire([re('a', 'i'), { k: re('b') }, 'c', 1, null, { regexp: 1 }]), [
      /a/i,
      { k: /b/ },
      'c',
      1,
      null,
      { regexp: 1 },
    ])
    // An object that only carries `regexp` beside other keys is a value, not a pattern.
    assert.deepEqual(fromWire({ regexp: 'a', other: 1 }), { regexp: 'a', other: 1 })
  })
})
