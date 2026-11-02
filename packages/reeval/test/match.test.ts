// One matcher table (src/matchers.ts) for both ways a matcher is called: the published `Matchers`
// interface names exactly its rows, and the attempt protocol's `expect` call (src/attempt/match.ts)
// records every matcher, label and ` #n` included, as the TypeScript `expect` does.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { assertionRecords, checkFailure } from '../src/attempt/assertions.ts'
import {
  type ExpectCall,
  expectCall,
  fromWire,
  match,
  recordCall,
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
import type {
  AssertionRecord,
  AttemptContext,
  Capture,
  TranscriptEvent,
  Verdict,
} from '../src/types.ts'
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

const capture: Capture = {
  name: 'home',
  port: 3000,
  path: '/',
  viewport: { width: 1280, height: 800 },
  file: { path: 'artifacts/home.png', sha256: 'abc', bytes: 1 },
  status: 404,
  finalUrl: '/login',
  console: [],
  errors: ['Uncaught Error: boom\n    at /assets/index.js:1:2'],
  failedRequests: [],
}

/** A verdict or capture as `c.judge` and `c.capture` return it, naming its question or name. */
const named = (v: object) =>
  Object.defineProperty({ ...v }, SUBJECT, {
    value: 'verdict' in v ? (v as Verdict).question : (v as { name?: string }).name,
  })

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
/** A budget refuses `.not` on both paths, with a `TypeError` that ends the body. */
const NEGATES = new Set(Object.keys(MATCHERS).filter((name) => name !== 'toStayWithin'))

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
  ['toStayWithin', { turn: 0 }, [{ toolCalls: 10, duration: '5m' }]],
  ['toHaveChanged', { turn: 0 }, ['docs']],
  ['toHaveChanged', { turn: 0 }, [`docs/${'x'.repeat(80)}`]],
  ['toHaveStatus', { value: capture as never }, [404]],
  ['toHaveStatus', { value: capture as never }, [200]],
  ['toHaveStatus', { value: capture as never }, ['4xx']],
  ['toHaveStatus', { value: capture as never }, ['2xx']],
  ['toHaveStatus', { value: { nope: true } }, [200]],
  ['toHaveNoPageErrors', { value: capture as never }, []],
  ['toHaveNoPageErrors', { value: { ...capture, errors: [] } as never }, []],
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
    const names = [...(body ?? '').matchAll(/^ {4}(\w+)[(:]/gm)].map((m) => m[1])
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
      for (const not of NEGATES.has(matcher) ? [false, true] : [false]) {
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
          soft: true,
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
    assert.equal(ts.length, CASES.length * 2 - CASES.filter(([m]) => !NEGATES.has(m)).length)
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

  test('.not.toStayWithin is a TypeError from a protocol call and from the TypeScript expect', async () => {
    const own = createExpect(task()) as unknown as (v: unknown) => {
      not: { toStayWithin: (l: unknown) => void }
    }
    assert.throws(() => own(tsSubject({ turn: 0 })).not.toStayWithin({ toolCalls: 1 }), TypeError)
    const call = {
      op: 'expect',
      subject: { turn: 0 },
      matcher: 'toStayWithin',
      args: [{ toolCalls: 1 }],
      not: true,
      soft: true,
    } as ExpectCall
    await assert.rejects(expectCall(c, [], call), TypeError)
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

  test('a record call joins the matcher calls, named and numbered as they are', () => {
    const calls: RawAssertion[] = []
    const check = { op: 'record', matcher: 'assert' } as const
    recordCall(calls, { ...check, subject: 'result.ok', status: 'pass' })
    const again = recordCall(calls, { ...check, subject: 'result.ok', status: 'pass' })
    assert.equal(again.label, 'assert result.ok #2')
    const soft = recordCall(calls, {
      ...check,
      label: 'copy is final',
      status: 'fail',
      message: "copy is final: assert 'draft' == 'final'",
      soft: true,
    })
    assert.deepEqual(soft, {
      label: 'copy is final',
      labelled: true,
      matcher: 'assert',
      status: 'fail',
      soft: true,
      message: "copy is final: assert 'draft' == 'final'",
    })
    assert.equal(checkFailure(calls)?.message, "copy is final: assert 'draft' == 'final'")
    assert.equal(recordCall(calls, { ...check, status: 'fail' }).message, 'assert failed')
    assert.equal(assertionRecords(calls).length, 4)
  })

  test('a reply already sent keeps its label when a later given label looks like its #n', () => {
    const calls: RawAssertion[] = []
    const check = { op: 'record', matcher: 'assert', status: 'pass' } as const
    const replies = ['build', 'build', 'build #2'].map(
      (label) => recordCall(calls, { ...check, label }).label,
    )
    assert.deepEqual(replies, ['build', 'build #2', 'build #2 #2'])
    assert.deepEqual(
      assertionRecords(calls).map((r) => r.label),
      replies,
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

// The matchers fixtures assert with: pass, fail, and the message a failure shows.
const fileTurn = (content: Record<string, string>) => ({
  readFile: async (path: string) => content[path] ?? null,
})

describe('toHaveFile', () => {
  const t = fileTurn({ 'a.txt': 'hello\nworld\n' })

  test('passes when the file exists, with or without a matching pattern', async () => {
    assert.equal((await matchers.toHaveFile(t, 'a.txt')).pass, true)
    assert.equal((await matchers.toHaveFile(t, 'a.txt', /wor/)).pass, true)
    assert.equal((await matchers.toHaveFile(t, 'a.txt', 'hello')).pass, true)
  })

  test('fails on a missing file, naming it', async () => {
    const r = await matchers.toHaveFile(t, 'missing.txt', /x/)
    assert.equal(r.pass, false)
    assert.equal(r.message(), 'expected file missing.txt to exist')
  })

  test("fails when the content doesn't match, showing the pattern and the file's tail", async () => {
    const r = await matchers.toHaveFile(t, 'a.txt', /nope/)
    assert.equal(r.pass, false)
    assert.equal(r.message(), 'expected a.txt to match /nope/\n--- a.txt ---\nhello\nworld')
  })

  test('the negated message says "not"', async () => {
    const r = await matchers.toHaveFile(t, 'a.txt', 'hello')
    assert.equal(r.message(), 'expected a.txt not to match hello\n--- a.txt ---\nhello\nworld')
  })

  test('rejects something that has no files', async () => {
    await assert.rejects(matchers.toHaveFile({}, 'a.txt'), /toHaveFile\(\) expects a turn/)
  })
})

describe('toSucceed', () => {
  test('passes on exit 0', async () => {
    const r = await matchers.toSucceed(Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }))
    assert.equal(r.pass, true)
    assert.equal(r.message(), 'expected command to fail')
  })

  test('fails on another exit code, with stderr and stdout tails', async () => {
    const r = await matchers.toSucceed({ exitCode: 2, stdout: 'out\n', stderr: 'err\n' })
    assert.equal(r.pass, false)
    assert.equal(
      r.message(),
      'expected command to succeed, exit code 2\n--- stderr ---\nerr\n--- stdout ---\nout',
    )
  })

  test('keeps only the last 20 lines of each stream', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
    const r = await matchers.toSucceed({ exitCode: 1, stdout: '', stderr: lines })
    assert.match(r.message(), /--- stderr ---\nline 11\n[\s\S]*line 30\n--- stdout ---/)
    assert.doesNotMatch(r.message(), /line 10\n/)
  })

  test('answers an awaited result at once, and only a promise later', async () => {
    const result = { exitCode: 1, stdout: '', stderr: '' }
    const now = matchers.toSucceed(result)
    assert.ok(!(now instanceof Promise))
    assert.equal(now.pass, false)
    const later = matchers.toSucceed(Promise.resolve(result))
    assert.ok(later instanceof Promise)
    assert.equal((await later).pass, false)
  })

  test('rejects something that is not an exec result', async () => {
    assert.throws(() => matchers.toSucceed('nope'), /toSucceed\(\) expects a c\.exec\(\) result/)
    await assert.rejects(
      async () => matchers.toSucceed(Promise.resolve('nope')),
      /toSucceed\(\) expects a c\.exec\(\) result/,
    )
  })
})

describe('toPass', () => {
  const verdict = (over: Partial<Verdict>): Verdict =>
    ({
      verdict: 'pass',
      score: 0.9,
      threshold: 0.8,
      question: 'Is it polite?',
      model: 'fake/judge',
      ...over,
    }) as Verdict

  test('passes on a pass verdict, with a negated message', () => {
    const r = matchers.toPass(verdict({}))
    assert.equal(r.pass, true)
    assert.equal(r.message(), 'expected judge to fail: score 0.90 ≥ 0.8 for "Is it polite?"')
  })

  test('fails below the threshold, naming the score, question and model', () => {
    const r = matchers.toPass(verdict({ verdict: 'fail', score: 0.4 }))
    assert.equal(r.pass, false)
    assert.equal(r.message(), 'judge score 0.40 is below 0.8 for "Is it polite?" (fake/judge)')
  })

  test('rejects something that is not a verdict', () => {
    assert.throws(() => matchers.toPass({}), /toPass\(\) expects a c\.judge\(\) verdict/)
  })
})

describe('toHaveStatus and toHaveNoPageErrors', () => {
  test("compares the document's status, naming the capture and where it ended up", () => {
    assert.equal(matchers.toHaveStatus(capture, 404).pass, true)
    const r = matchers.toHaveStatus(capture, 200)
    assert.equal(r.pass, false)
    assert.equal(r.message(), 'expected capture "home" at /login to answer 200, got 404')
    const none = matchers.toHaveStatus({ ...capture, status: undefined }, 200)
    assert.equal(
      none.message(),
      'expected capture "home" at /login to answer 200, but no response came',
    )
  })

  test('takes a range of statuses, from 1xx to 5xx', () => {
    assert.equal(matchers.toHaveStatus(capture, '4xx').pass, true)
    for (const status of [400, 499]) {
      assert.equal(matchers.toHaveStatus({ ...capture, status }, '4xx').pass, true)
    }
    assert.equal(matchers.toHaveStatus({ ...capture, status: 500 }, '4xx').pass, false)
    assert.equal(matchers.toHaveStatus({ ...capture, status: 101 }, '1xx').pass, true)
    const r = matchers.toHaveStatus(capture, '2xx')
    assert.equal(r.pass, false)
    assert.equal(r.message(), 'expected capture "home" at /login to answer 2xx, got 404')
    assert.equal(
      matchers.toHaveStatus(capture, '4xx').message(),
      'expected capture "home" at /login not to answer 4xx',
    )
    const none = matchers.toHaveStatus({ ...capture, status: undefined }, '2xx')
    assert.equal(none.pass, false)
    assert.equal(
      none.message(),
      'expected capture "home" at /login to answer 2xx, but no response came',
    )
  })

  test('lists the first page errors, cut to their first frames, and counts the rest', () => {
    const stack = 'Uncaught Error: boom\n    at a (/x.js:1:1)\n    at b\n    at c\n    at d'
    const r = matchers.toHaveNoPageErrors({ ...capture, errors: Array(7).fill(stack) })
    assert.equal(r.pass, false)
    const lines = r.message().split('\n')
    assert.equal(
      lines[0],
      'expected no page errors at capture "home" at /login, got 7 page errors: Uncaught Error: boom',
    )
    assert.equal(lines.filter((l) => l.endsWith('Uncaught Error: boom')).length, 5)
    assert.ok(!r.message().includes('at d'))
    assert.equal(lines.at(-1), '… 2 more in home.capture.json')
    assert.equal(matchers.toHaveNoPageErrors({ ...capture, errors: [] }).pass, true)
  })

  test('rejects something that is not a capture', () => {
    assert.throws(
      () => matchers.toHaveStatus({}, 200),
      /toHaveStatus\(\) expects a c\.capture\(\) result/,
    )
    assert.throws(
      () => matchers.toHaveNoPageErrors({ exitCode: 0 }),
      /toHaveNoPageErrors\(\) expects a c\.capture\(\) result/,
    )
    for (const bad of ['200', '6xx', '2XX', 2, 99, 600, 200.5, Number.NaN]) {
      assert.throws(
        () => matchers.toHaveStatus(capture, bad as never),
        new RegExp(
          `toHaveStatus\\(\\) expects a status from 100 to 599 or a range from '1xx' to '5xx', got ${JSON.stringify(bad)}`,
        ),
      )
    }
  })
})

describe('toHaveFetched and toHaveSearched', () => {
  const at = { ts: '2026-09-26T17:04:55.000Z', atMs: 0, durationMs: 950 }
  const turn = (unreported: Array<'web-search' | 'web-fetch'> = []) => ({
    unreported,
    transcript: [
      {
        ...at,
        type: 'web-fetch' as const,
        toolCallId: 'f',
        url: 'https://httpbin.org/ip',
        ok: true,
      },
      {
        ...at,
        type: 'web-search' as const,
        toolCallId: 's',
        query: 'IANA example domain RFC 2606',
        references: 2,
      },
    ],
  })

  test('pass on a matching event, by substring or pattern, or on any event with none given', () => {
    assert.equal(matchers.toHaveFetched(turn(), 'httpbin.org').pass, true)
    assert.equal(matchers.toHaveFetched(turn(), /\/ip$/).pass, true)
    assert.equal(matchers.toHaveFetched(turn()).pass, true)
    assert.equal(matchers.toHaveSearched(turn(), /RFC 2606/).pass, true)
  })

  test('fail naming what the turn did fetch or search', () => {
    const r = matchers.toHaveFetched(turn(), 'example.com')
    assert.equal(r.pass, false)
    assert.equal(
      r.message(),
      'expected web fetches matching example.com, got ["https://httpbin.org/ip"]',
    )
    const none = matchers.toHaveSearched({ unreported: [], transcript: [] })
    assert.equal(none.message(), 'expected web searches, got none')
  })

  test("refuse a turn whose harness doesn't report them, negated or not: never a silent pass", () => {
    const cursor = { unreported: ['web-search', 'web-fetch'] as const, transcript: [] }
    for (const check of [
      () => matchers.toHaveFetched({ ...cursor, unreported: [...cursor.unreported] }, 'httpbin'),
      () => matchers.toHaveSearched({ ...cursor, unreported: [...cursor.unreported] }),
    ]) {
      assert.throws(check, (e: Error) => {
        assert.equal(e.name, 'HarnessCapabilityError')
        assert.match(
          e.message,
          /doesn't report web (fetches|searches) \('web-(fetch|search)' is in turn\.unreported\)/,
        )
        return true
      })
    }
    // Only the unreported type is refused.
    assert.equal(matchers.toHaveSearched(turn(['web-fetch']), 'RFC').pass, true)
  })

  test('reject something that is not a turn', () => {
    assert.throws(
      () => matchers.toHaveFetched({}),
      /toHaveFetched\(\) expects a turn from c.send\(\), or c/,
    )
  })

  test('accept c, every turn so far', () => {
    assert.equal(matchers.toHaveFetched({ turns: [turn()] }, 'httpbin.org').pass, true)
  })

  test('pass on a refused web-search (ok: false); .not fails', () => {
    const refused = {
      unreported: [] as Array<'web-search' | 'web-fetch'>,
      transcript: [
        {
          ...at,
          type: 'web-search' as const,
          toolCallId: 's',
          query: 'firebase ui web',
          references: null,
          ok: false,
        },
      ],
    }
    assert.equal(matchers.toHaveSearched(refused).pass, true)
    assert.equal(matchers.toHaveSearched(refused, 'firebase').pass, true)
    assert.equal(matchers.toHaveSearched(refused, 'unrelated').pass, false)
  })
})

describe('toBe and toEqual', () => {
  test('toBe uses Object.is', () => {
    assert.equal(matchers.toBe(1, 1).pass, true)
    const r = matchers.toBe(1, 2)
    assert.equal(r.pass, false)
    assert.match(r.message(), /Object\.is equality/)
  })

  test('toEqual uses deep strict equality', () => {
    assert.equal(matchers.toEqual({ a: 1 }, { a: 1 }).pass, true)
    const r = matchers.toEqual(1, 2)
    assert.equal(r.pass, false)
    assert.match(r.message(), /deeply equal/)
  })
})
