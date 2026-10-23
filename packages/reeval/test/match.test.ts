// One matcher table (src/matchers.ts) for both ways a matcher is called: the published `Matchers`
// interface names exactly its rows, and the attempt protocol's `expect` call (src/attempt/match.ts)
// records every matcher, label and ` #n` included, as the TypeScript `expect` does.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { assertionRecords } from '../src/attempt/assertions.ts'
import {
  type ExpectCall,
  expectCall,
  fromWire,
  match,
  type UntestedReply,
} from '../src/attempt/match.ts'
import {
  createExpect,
  type ExpectTask,
  extendExpect,
  type RawAssertion,
  rawAssertions,
  SUBJECT,
} from '../src/engine/expect.ts'
import { MATCHERS, matchers } from '../src/matchers.ts'
import type { AssertionRecord, AttemptContext, TranscriptEvent, Verdict } from '../src/types.ts'
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
  // Names its command, as c.exec's promise does.
  exec: (command: string) =>
    Object.defineProperty(
      Promise.resolve(
        command === 'true'
          ? { exitCode: 0, stdout: 'ok\n', stderr: '' }
          : { exitCode: 1, stdout: '', stderr: 'boom\n' },
      ),
      SUBJECT,
      { value: command },
    ),
  readFile: async (path: string) => files[path] ?? null,
} as unknown as AttemptContext

const verdict: Verdict = {
  verdict: 'fail',
  score: 0.3,
  threshold: 0.8,
  question: 'Is it polite?',
  model: 'fake/judge',
}

/** A verdict as `c.judge` returns it, naming its question. */
const named = (v: object) =>
  Object.defineProperty({ ...v }, SUBJECT, { value: (v as Verdict).question })

const re = (regexp: string, flags?: string) => ({ regexp, ...(flags ? { flags } : {}) })

/** The record a call replied with, failing on an `untested` reply. */
const recorded = (reply: { assertion: AssertionRecord } | UntestedReply) => {
  assert.ok('assertion' in reply, JSON.stringify(reply))
  return reply.assertion
}

/** The matcher call `match` ran, failing on an `untested` reply. */
const ran = (result: RawAssertion | UntestedReply) => {
  assert.ok(!('untested' in result), JSON.stringify(result))
  return result
}

/**
 * Each row: the protocol call's subject and wire arguments, and its label; every row runs with
 * and without `.not`, so repeated labels are numbered.
 */
const CASES: Array<[keyof typeof MATCHERS, ExpectCall['subject'], unknown[], string?]> = [
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
  ['toHaveRun', { turn: 0 }, ['npm'], 'runs the tests'],
  ['toHaveFetched', { turn: 0 }, [], 'fetched something'],
  ['toHaveEdited', { turn: 0 }, ['greet.js']],
  ['toHaveChanged', { attempt: true }, [['src', re('\\.md$')]]],
  ['toHaveChanged', { turn: 0 }, ['docs']],
  ['toHaveChanged', { turn: 0 }, [`docs/${'x'.repeat(80)}`]],
  ['toPass', { value: verdict as never }, []],
  ['toPass', { value: { ...verdict, verdict: 'pass', score: 0.9 } as never }, []],
  ['toPass', { value: { nope: true } }, []],
  ['toBe', { value: 1 }, [1]],
  ['toBe', { value: 1 }, [2]],
  ['toEqual', { value: { a: 1 } }, [{ a: 1 }]],
  ['toEqual', { value: 1 }, [2]],
  ['toBeNull', { value: null }, []],
  ['toBeNull', { value: 0 }, []],
  ['toBeTruthy', { value: true }, []],
  ['toBeTruthy', { value: false }, []],
  ['toContain', { value: 'hello' }, ['ell']],
  ['toContain', { value: 'hello' }, ['nope']],
]

/** The subject as an eval's body hands it to `expect`. */
const tsSubject = (subject: ExpectCall['subject']): unknown =>
  'turn' in subject
    ? turn
    : 'attempt' in subject
      ? c
      : 'value' in subject
        ? subject.value !== null && typeof subject.value === 'object'
          ? named(subject.value as object)
          : subject.value
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

  test('every matcher records the same from a protocol call as from the TypeScript expect', async () => {
    assert.deepEqual(
      [...new Set(CASES.map(([name]) => name))].sort(),
      Object.keys(MATCHERS).sort(),
      'a case for every matcher',
    )
    const t = task()
    const own = createExpect(t)
    const calls: RawAssertion[] = []
    const replies = []
    for (const [matcher, subject, args, label] of CASES) {
      for (const not of [false, true]) {
        const chain = own(tsSubject(subject), label) as unknown as Record<string, unknown>
        const assertion = (not ? chain.not : chain) as Record<string, (...a: unknown[]) => unknown>
        await Promise.resolve()
          .then(() => assertion[matcher]?.(...args.map(fromWire)))
          .catch(() => {})
        const call = {
          op: 'expect',
          subject,
          matcher,
          args,
          not,
          soft: false,
          ...(label ? { label } : {}),
        } as ExpectCall
        replies.push(recorded(await expectCall(c, calls, call)))
      }
    }
    const timing = ({ durationMs, ...x }: { durationMs?: number }) => ({
      ...x,
      timed: durationMs !== undefined,
    })
    const ts = assertionRecords(rawAssertions(t)).map(timing)
    assert.equal(ts.length, CASES.length * 2)
    assert.deepEqual(replies.map(timing), ts)
    assert.deepEqual(assertionRecords(calls).map(timing), ts, 'each reply is its final record')
    assert.deepEqual([...new Set(ts.map((x) => x.status))].sort(), ['error', 'fail', 'pass'])
    const labels = ts.map((x) => x.label)
    for (const label of [
      'toHaveFile greet.js #2',
      'runs the tests #2',
      'toSucceed true',
      'toPass Is it polite?',
      `toHaveChanged docs/${'x'.repeat(41)}…`,
    ]) {
      assert.ok(labels.includes(label), `${label} in ${JSON.stringify(labels)}`)
    }
  })

  test('concurrent calls are numbered in the order they were made, not the order they finish', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slowFirst = {
      ...c,
      readFile: async (path: string) => {
        if (path === 'slow') await gate
        return files['greet.js'] ?? null
      },
    } as unknown as AttemptContext
    const call = (path: string): ExpectCall => ({
      op: 'expect',
      subject: { readFile: path },
      matcher: 'toContain',
      args: ['greet'],
      not: false,
      soft: false,
    })
    const calls: RawAssertion[] = []
    const first = expectCall(slowFirst, calls, call('slow'))
    const second = recorded(await expectCall(slowFirst, calls, call('fast')))
    release()
    assert.deepEqual(
      [recorded(await first).label, second.label],
      ['toContain greet', 'toContain greet #2'],
    )
    assert.deepEqual(
      assertionRecords(calls).map((r) => r.label),
      ['toContain greet', 'toContain greet #2'],
    )
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
      soft: true,
      poll: { interval: 5, timeout: 1000 },
    }
    const passed = ran(await match(later, call))
    assert.equal(reads, 3)
    assert.deepEqual(
      { ...passed, durationMs: typeof passed.durationMs },
      {
        matcher: 'poll.toHaveFile',
        args: ['greet.js'],
        soft: true,
        status: 'pass',
        durationMs: 'number',
      },
    )
    const never = ran(
      await match(c, {
        ...call,
        args: ['missing.js'],
        not: false,
        poll: { interval: 5, timeout: 30 },
      }),
    )
    assert.equal(never.status, 'fail')
    assert.equal((never.error as Error).message, 'expected file missing.js to exist')
    assert.equal(ran(await match(c, { ...call, poll: {} })).status, 'pass')
    const sync = ran(await match(c, { ...call, matcher: 'toHaveRun', args: [], poll: undefined }))
    assert.equal(sync.durationMs, undefined, 'only async or polled calls are timed')
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
    await assert.rejects(match(c, { ...call, matcher: 'toBeTruthyEnough' }), {
      name: 'UsageError',
      message: /^toBeTruthyEnough isn't one of reeval's matchers \(toBe, toEqual, /,
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

  test("a runner's own pattern is answered by the runner: reeval asks for the strings it tested, and records nothing until it has them", async () => {
    const pattern = (answers: Record<string, boolean>) => ({
      matchedBy: "re.compile('npm t(est)?')",
      answers,
    })
    const call: ExpectCall = {
      op: 'expect',
      subject: { turn: 0 },
      matcher: 'toHaveRun',
      args: [pattern({})],
      not: false,
      soft: false,
    }
    const calls: RawAssertion[] = []
    assert.deepEqual(await expectCall(c, calls, call), {
      untested: { "re.compile('npm t(est)?')": ['npm test'] },
    })
    assert.deepEqual(calls, [], 'an asking call takes no slot')
    const passed = recorded(
      await expectCall(c, calls, { ...call, args: [pattern({ 'npm test': true })] }),
    )
    assert.deepEqual(
      { status: passed.status, label: passed.label },
      { status: 'pass', label: "toHaveRun re.compile('npm t(est)?')" },
    )
    const failed = recorded(
      await expectCall(c, calls, { ...call, not: true, args: [pattern({ 'npm test': true })] }),
    )
    assert.equal(failed.status, 'fail')
    assert.match(failed.message ?? '', /re\.compile\('npm t\(est\)\?'\)/)
    const missing = recorded(
      await expectCall(c, calls, { ...call, args: [pattern({ 'npm test': false })] }),
    )
    assert.equal(missing.status, 'fail')
    assert.deepEqual(
      assertionRecords(calls).map((r) => r.label),
      [
        "toHaveRun re.compile('npm t(est)?')",
        "not.toHaveRun re.compile('npm t(est)?')",
        "toHaveRun re.compile('npm t(est)?') #2",
      ],
    )
  })

  test("a polled call asks for each new string its subject's re-reads turn up", async () => {
    let reads = 0
    const later = {
      ...c,
      readFile: async () => (++reads >= 2 ? 'hello, world' : 'hello'),
    } as unknown as AttemptContext
    const call = (answers: Record<string, boolean>): ExpectCall => ({
      op: 'expect',
      subject: { attempt: true },
      matcher: 'toHaveFile',
      args: ['greet.js', { matchedBy: "re.compile('world')", answers }],
      not: false,
      soft: false,
      poll: { interval: 5, timeout: 1000 },
    })
    assert.deepEqual(await match(later, call({})), {
      untested: { "re.compile('world')": ['hello'] },
    })
    assert.deepEqual(await match(later, call({ hello: false })), {
      untested: { "re.compile('world')": ['hello, world'] },
    })
    const passed = ran(await match(later, call({ hello: false, 'hello, world': true })))
    assert.equal(passed.status, 'pass')
    assert.equal(String(passed.args[1]), "re.compile('world')")
  })
})
