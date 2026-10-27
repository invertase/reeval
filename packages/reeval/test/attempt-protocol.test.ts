// The attempt protocol's contract (src/contract/attempt.ts): real turns from the record corpus fit
// it as replies, under both its Zod schemas and the JSON Schema in schema/protocol/; every reeval
// matcher can be named in a call; and its shared defs stay held to their hand-written types.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { corpus } from '../scripts/schema/corpus.ts'
import type { ShapeSchema } from '../scripts/schema/generate.ts'
import { typeDrift } from '../scripts/schema/protocol.ts'
import { validate } from '../scripts/schema/validate.ts'
import { zodDefs } from '../scripts/schema/zod.ts'
import {
  ATTEMPT_SCHEMAS,
  attemptAbortSchema,
  attemptDoneSchema,
  attemptReplySchema,
  attemptRequestSchema,
  attemptStartSchema,
  transcriptEventSchema,
} from '../src/contract/attempt.ts'
import { matchers } from '../src/matchers.ts'
import type { TranscriptEvent, TurnData } from '../src/types.ts'
import { readableTranscriptLine } from '../src/view/record.ts'

const snapshot = (name: string): ShapeSchema =>
  JSON.parse(
    readFileSync(new URL(`../schema/protocol/${name}.schema.json`, import.meta.url), 'utf8'),
  )

type Line = { turn: number; type: string; [key: string]: unknown }

/** Each transcript in the corpus as the turns a `send` reply would carry. */
function corpusTurns(): TurnData[] {
  return corpus().transcripts.flatMap((file) => {
    const turns = new Map<number, TurnData>()
    for (const text of readFileSync(file, 'utf8').split('\n')) {
      if (!text.trim()) continue
      const { turn, ...line } = readableTranscriptLine(JSON.parse(text)) as unknown as Line
      if (line.type === 'prompt') {
        turns.set(turn, {
          prompt: line.text as string,
          text: '',
          status: 'completed',
          startedAt: line.ts as string,
          durationMs: 0,
          transcript: [],
          usage: null,
          model: null,
          unreported: [],
          diff: { patch: '', files: [] },
        })
      } else if (line.type === 'turn-end') {
        const t = turns.get(turn) as TurnData
        Object.assign(t, { status: line.status, durationMs: line.durationMs })
      } else (turns.get(turn) as TurnData).transcript.push(line as unknown as TranscriptEvent)
    }
    return [...turns.values()]
  })
}

test('every turn in the record corpus fits a send reply, in Zod and in the JSON Schema', () => {
  const turns = corpusTurns()
  assert.ok(turns.length >= 100, `${turns.length} turns`)
  const kinds = new Set(turns.flatMap((t) => t.transcript.map((e) => e.type)))
  assert.deepEqual([...kinds].sort(), ['file-edit', 'reasoning', 'text', 'tool'])
  const reply = snapshot('attempt-reply')
  for (const [i, turn] of turns.entries()) {
    const value = { id: String(i), ok: true, op: 'send', turn }
    const parsed = attemptReplySchema.safeParse(value)
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues[0]))
    assert.deepEqual(validate(reply, value), [])
  }
  // The canary: an event with a field the transcript doesn't have.
  const [first] = turns
  const event = { ...(first?.transcript[0] as TranscriptEvent), color: 'blue' }
  assert.equal(transcriptEventSchema.safeParse(event).success, false)
})

test('every judgment in the record corpus fits a judge reply, in Zod and in the JSON Schema', () => {
  const judgments = corpus().records.flatMap(({ value }) =>
    ((value.evals ?? []) as Array<{ attempts?: Array<{ judgements?: unknown[] }> }>).flatMap((e) =>
      (e.attempts ?? []).flatMap((a) => a.judgements ?? []),
    ),
  ) as Array<Record<string, unknown>>
  assert.ok(judgments.length >= 10, `${judgments.length} judgments`)
  const reply = snapshot('attempt-reply')
  for (const [i, { key: _, retries: __, ...verdict }] of judgments.entries()) {
    const value = { id: String(i), ok: true, op: 'judge', verdict }
    const parsed = attemptReplySchema.safeParse(value)
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues[0]))
    assert.deepEqual(validate(reply, value), [])
  }
  const failure = {
    verdict: 'error',
    score: null,
    threshold: 0.8,
    question: 'Does greet.js export greet?',
    model: 'google/gemini-3.8-flash',
    error: '503 Service Unavailable',
  }
  const value = { id: 'f', ok: true, op: 'judge', verdict: failure }
  assert.ok(attemptReplySchema.safeParse(value).success)
  assert.deepEqual(validate(reply, value), [])
  // The canary: a failure that still carries a score.
  const scored = { ...value, verdict: { ...failure, score: 0.4 } }
  assert.equal(attemptReplySchema.safeParse(scored).success, false)
  assert.notDeepEqual(validate(reply, scored), [])
})

test('every attempt in the record corpus has a start message, in Zod and in the JSON Schema', () => {
  type Cell = { key: string; harness: string; environment: string; sandbox: string; role: string }
  type Eval = {
    file: string
    name: string
    cells?: Array<Cell & { variant?: string }>
    attempts?: Array<{ id: string; cell: string; n: number }>
  }
  const starts = corpus().records.flatMap(({ value }) =>
    ((value.evals ?? []) as Eval[]).flatMap((e) =>
      (e.attempts ?? []).map((a) => {
        const found = e.cells?.find((c) => c.key === a.cell)
        assert.ok(found, `${e.name}: attempt ${a.id}'s cell ${a.cell}`)
        const { key, harness, environment, sandbox, role, variant } = found
        const cell = { key, harness, environment, sandbox, role, ...(variant ? { variant } : {}) }
        return { type: 'start', attempt: { id: a.id, cell, n: a.n }, file: e.file, body: e.name }
      }),
    ),
  )
  assert.ok(starts.length >= 50, `${starts.length} attempts`)
  assert.ok(starts.some((s) => s.attempt.cell.role === 'variant'))
  const schema = snapshot('attempt-start')
  for (const start of starts) {
    const parsed = attemptStartSchema.safeParse(start)
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues[0]))
    assert.deepEqual(validate(schema, start), [])
  }
  // The canary: a run number as a string.
  const [first] = starts
  const text = { ...first, attempt: { ...first?.attempt, n: '1' } }
  assert.equal(attemptStartSchema.safeParse(text).success, false)
  assert.notDeepEqual(validate(schema, text), [])
})

test('abort and done round-trip through JSON unchanged', () => {
  const abort = { type: 'abort', reason: 'timeout', message: 'Eval timed out after 600s' }
  const done = { type: 'done', error: { name: 'AssertionError', message: 'expected 1 to be 2' } }
  for (const [schema, value, name] of [
    [attemptAbortSchema, abort, 'attempt-abort'],
    [attemptDoneSchema, done, 'attempt-done'],
    [attemptDoneSchema, { type: 'done' }, 'attempt-done'],
  ] as const) {
    const through = JSON.parse(JSON.stringify(value))
    assert.deepEqual(schema.parse(through), value)
    assert.deepEqual(validate(snapshot(name), through), [])
  }
})

test('every matcher reeval adds can be named in an expect call', () => {
  const names = Object.keys(matchers)
  assert.ok(names.includes('toHaveFile') && names.includes('toSucceed'), names.join(', '))
  const request = snapshot('attempt-request')
  for (const matcher of names) {
    const value = {
      id: '1',
      call: {
        op: 'expect',
        subject: { attempt: true },
        matcher,
        args: [],
        not: false,
        soft: false,
      },
    }
    assert.ok(attemptRequestSchema.safeParse(value).success, matcher)
    assert.deepEqual(validate(request, value), [], matcher)
  }
})

test('a call and its reply round-trip through JSON unchanged', () => {
  const request = {
    id: '7',
    call: {
      op: 'expect',
      subject: { turn: 0 },
      matcher: 'toHaveRun',
      args: [{ regexp: '^npm (test|t)$', flags: 'i' }, 'and a string'],
      not: true,
      soft: true,
      label: 'never runs the tests',
    },
  }
  const reply = {
    id: '7',
    ok: true,
    op: 'expect',
    assertion: {
      label: 'never runs the tests',
      labelled: true,
      matcher: 'not.toHaveRun',
      status: 'pass',
      soft: true,
    },
  }
  const failed = {
    id: '8',
    ok: false,
    op: 'exec',
    error: { name: 'UsageError', message: 'No sandbox yet', stack: 'at …' },
  }
  for (const [schema, value, name] of [
    [attemptRequestSchema, request, 'attempt-request'],
    [attemptReplySchema, reply, 'attempt-reply'],
    [attemptReplySchema, failed, 'attempt-reply'],
  ] as const) {
    const through = JSON.parse(JSON.stringify(value))
    assert.deepEqual(schema.parse(through), value)
    assert.deepEqual(validate(snapshot(name), through), [])
  }
})

test('a served app, captured, polled and killed, round-trips through JSON unchanged', () => {
  const capture = {
    name: 'about',
    port: 3000,
    path: '/about',
    viewport: 'full-page',
    file: { path: 'artifacts/about.png', sha256: 'ab12', bytes: 2048 },
  }
  const poll = {
    op: 'expect',
    subject: { exec: 'curl -sf localhost:3000/health' },
    matcher: 'toSucceed',
    args: [],
    not: false,
    soft: false,
    poll: { interval: 200, timeout: 10000 },
  }
  const steps = [
    [
      { op: 'serve', command: 'npm start', port: 3000 },
      { op: 'serve', handle: 'h1', port: 3000 },
    ],
    [
      { op: 'exec', command: 'npm run watch', background: true },
      { op: 'exec', result: { handle: 'h2' } },
    ],
    [
      { op: 'capture', target: { handle: 'h1' }, options: { path: '/about', wait: 'idle' } },
      { op: 'capture', capture },
    ],
    [
      poll,
      {
        op: 'expect',
        assertion: {
          label: 'expect(…).toSucceed()',
          labelled: false,
          matcher: 'toSucceed',
          status: 'pass',
          soft: false,
        },
      },
    ],
    [{ op: 'kill', handle: 'h2' }, { op: 'kill' }],
    [{ op: 'kill', handle: 'h1' }, { op: 'kill' }],
  ] as const
  for (const [i, [call, result]] of steps.entries()) {
    const request = JSON.parse(JSON.stringify({ id: String(i), call }))
    const reply = JSON.parse(JSON.stringify({ id: String(i), ok: true, ...result }))
    assert.deepEqual(attemptRequestSchema.parse(request), request)
    assert.deepEqual(validate(snapshot('attempt-request'), request), [])
    assert.deepEqual(attemptReplySchema.parse(reply), reply)
    assert.deepEqual(validate(snapshot('attempt-reply'), reply), [])
  }
  // The canaries: a background exec's reply that also carries output, a numeric handle, and a
  // polled value. validate() allows extra keys, so only Zod refuses the first.
  const both = { id: '1', ok: true, op: 'exec', result: { handle: 'h2', exitCode: 0 } }
  assert.equal(attemptReplySchema.safeParse(both).success, false)
  const numeric = { id: '1', ok: true, op: 'serve', handle: 1, port: 3000 }
  assert.equal(attemptReplySchema.safeParse(numeric).success, false)
  assert.notDeepEqual(validate(snapshot('attempt-reply'), numeric), [])
  const value = { id: '1', call: { ...poll, subject: { value: 1 } } }
  assert.equal(attemptRequestSchema.safeParse(value).success, false)
})

test("the protocol's shared defs match their types' properties and TSDoc", () => {
  const defs = zodDefs(ATTEMPT_SCHEMAS, {})
  assert.deepEqual(typeDrift(defs), [])
  const exec = defs.ExecResult ?? {}
  const drifted = {
    ...defs,
    ExecResult: {
      ...exec,
      properties: { ...exec.properties, signal: { type: 'string' as const } },
    },
  }
  assert.deepEqual(typeDrift(drifted), ['ExecResult: Zod only:   signal?'])
})
