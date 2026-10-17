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
  attemptReplySchema,
  attemptRequestSchema,
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
  const event = { ...(first?.transcript[0] as TranscriptEvent), colour: 'blue' }
  assert.equal(transcriptEventSchema.safeParse(event).success, false)
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
