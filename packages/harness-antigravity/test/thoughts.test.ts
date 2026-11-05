import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { HarnessV1StreamPart } from '@ai-sdk/harness'
import { AntigravityStreamTranslator } from '../src/antigravity-stream.ts'
import {
  ANTIGRAVITY_DATA_DIR,
  type AntigravityThought,
  antigravityThoughtsCommand,
  parseAntigravityThoughts,
} from '../src/antigravity-thoughts.ts'
import { createAntigravity } from '../src/index.ts'
import { fakeSandbox, fixture, runTurn, visible } from './support.ts'

// A real two-turn conversation (agy 1.4.7, gemini-3.1-pro-preview): its stream-json, and the
// transcript_full.jsonl agy stored, which has each model step's thought summary.
const CONVERSATION = '9f3b0478-b125-4e8f-9fa4-f093817620c2'
const STORE = fileURLToPath(new URL('./fixtures/thoughts-store', import.meta.url))

/** A protobuf varint, and a length-delimited field. */
const varint = (n: number): number[] => {
  const out: number[] = []
  while (n >= 128) {
    out.push((n % 128) | 128)
    n = Math.floor(n / 128)
  }
  return [...out, n]
}
const len = (field: number, bytes: number[]) => [
  ...varint(field * 8 + 2),
  ...varint(bytes.length),
  ...bytes,
]
const int = (field: number, n: number) => [...varint(field * 8), ...varint(n)]

/** A step's payload as agy stores it: field 20 (the planner response) with field 11 (`thinking_duration`). */
const plannerStep = (seconds: number, nanos: number) =>
  new Uint8Array([
    ...int(1, 15),
    ...len(20, [
      ...len(3, [...Buffer.from('**Thinking**')]),
      ...len(11, [...int(1, seconds), ...int(2, nanos)]),
      ...int(12, 2),
    ]),
  ])

describe('the stored thoughts, read by the script that runs in the sandbox', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agy-thoughts-'))
    cpSync(STORE, join(home, ANTIGRAVITY_DATA_DIR), { recursive: true })
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const read = (fromStep: number) =>
    parseAntigravityThoughts(
      execFileSync(
        'sh',
        ['-c', antigravityThoughtsCommand({ home, conversationId: CONVERSATION, fromStep })],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ),
    )
  const database = async (rows: Array<[number, Uint8Array]>) => {
    const { DatabaseSync } = await import('node:sqlite')
    mkdirSync(join(home, ANTIGRAVITY_DATA_DIR, 'conversations'), { recursive: true })
    const db = new DatabaseSync(
      join(home, ANTIGRAVITY_DATA_DIR, 'conversations', `${CONVERSATION}.db`),
    )
    db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, step_payload blob)')
    const insert = db.prepare('INSERT INTO steps VALUES (?, ?)')
    for (const [idx, payload] of rows) insert.run(idx, payload)
    db.close()
  }

  test("each step's thought, from its step on, timed by the database's thinking_duration", async () => {
    await database([
      [1, plannerStep(7, 674_933_686)],
      [5, plannerStep(9, 0)],
      [8, plannerStep(3, 876_001_208)],
    ])
    const all = read(0)
    assert.deepEqual(
      all.map((t) => [t.step, t.durationMs]),
      [
        [1, 7675],
        [8, 3876],
      ],
      'step 5 replied with no thought, so it has none',
    )
    assert.match(all[0]?.text ?? '', /^\*\*Considering Tool Needs\*\*/)
    assert.deepEqual(
      read(6).map((t) => t.step),
      [8],
      "a resumed turn's steps only",
    )
  })

  test('twin: without the database the thoughts stand, untimed', () => {
    assert.deepEqual(
      read(0).map((t) => [t.step, t.durationMs]),
      [
        [1, null],
        [8, null],
      ],
    )
  })

  test('a conversation with no store has no thoughts', () => {
    rmSync(join(home, ANTIGRAVITY_DATA_DIR, 'brain'), { recursive: true })
    assert.deepEqual(read(0), [])
  })

  test('output that is not a list of thoughts reads as none', () => {
    assert.deepEqual(parseAntigravityThoughts(''), [])
    assert.deepEqual(parseAntigravityThoughts('{"step":1}'), [])
    assert.deepEqual(parseAntigravityThoughts('[{"step":"1","text":"x","durationMs":null}]'), [])
  })
})

/** A turn through the translator, on a clock that ticks 10 ms a line. */
function translate(
  ndjson: string,
  thoughts: AntigravityThought[] | undefined,
  conversationId?: string,
) {
  let clock = 1_000_000
  const t = new AntigravityStreamTranslator({ turn: 1, conversationId, now: () => clock })
  const parts: HarnessV1StreamPart[] = []
  const lines = ndjson.split('\n').filter(Boolean)
  for (const line of lines) {
    if (AntigravityStreamTranslator.isResult(line) && thoughts) t.recover(thoughts)
    clock += 10
    parts.push(...t.push(line))
  }
  return { parts: visible(parts), translator: t }
}

const THOUGHTS: AntigravityThought[] = [
  { step: 1, text: 'first thought', durationMs: 7675 },
  { step: 8, text: 'next turn', durationMs: 3876 },
]

describe('recovered thoughts in the turn', () => {
  test("they go out as reasoning blocks before the turn's reply and finish, placed by their step", () => {
    const { parts, translator } = translate(fixture('thoughts-turn-1.ndjson'), THOUGHTS)
    assert.equal(translator.firstReplyStep, 1)
    const reasoning = parts.filter((p) => p.type.startsWith('reasoning-'))
    assert.deepEqual(
      reasoning.map((p) => p.type),
      ['reasoning-start', 'reasoning-delta', 'reasoning-end'],
      "step 8 is the next turn's",
    )
    const types = parts.map((p) => p.type)
    assert.ok(types.indexOf('reasoning-end') < types.indexOf('text-start'))
    assert.equal(types.at(-1), 'finish')
    // Step 1's first event was the third line, at 1_000_030; the result, at 1_000_180.
    assert.deepEqual(reasoning[0], {
      type: 'reasoning-start',
      id: 'reasoning-1',
      harnessMetadata: {
        antigravity: { step: 1, startedBeforeMs: 1_000_180 - 1_000_020, durationMs: 7675 },
      },
    })
    assert.deepEqual(reasoning[1], {
      type: 'reasoning-delta',
      id: 'reasoning-1',
      delta: 'first thought',
    })
  })

  test("a resumed turn's thought starts no earlier than the event before its step", () => {
    const { parts, translator } = translate(
      fixture('thoughts-turn-2.ndjson'),
      THOUGHTS,
      CONVERSATION,
    )
    assert.equal(translator.firstReplyStep, 8)
    const start = parts.find((p) => p.type === 'reasoning-start')
    assert.deepEqual(start?.type === 'reasoning-start' && start.harnessMetadata, {
      antigravity: { step: 8, startedBeforeMs: 1_000_100 - 1_000_030, durationMs: 3876 },
    })
  })

  test('an untimed thought ends 1 ms before its step', () => {
    const { parts } = translate(fixture('thoughts-turn-1.ndjson'), [
      { step: 1, text: 'x', durationMs: null },
    ])
    const start = parts.find((p) => p.type === 'reasoning-start')
    assert.deepEqual(start?.type === 'reasoning-start' && start.harnessMetadata, {
      antigravity: { step: 1, startedBeforeMs: 1_000_180 - 1_000_029, durationMs: null },
    })
  })

  test('a turn the CLI ended without a result still carries them', () => {
    const lines = fixture('thoughts-turn-1.ndjson')
      .split('\n')
      .filter((l) => l && !AntigravityStreamTranslator.isResult(l))
    const t = new AntigravityStreamTranslator({ turn: 1 })
    for (const l of lines) t.push(l)
    t.recover(THOUGHTS)
    const parts = t.end({ exitCode: 1 })
    assert.deepEqual(
      parts.slice(0, 3).map((p) => p.type),
      ['reasoning-start', 'reasoning-delta', 'reasoning-end'],
    )
    assert.equal(parts.at(-1)?.type, 'finish')
  })

  test('twin: with none recovered the turn has no reasoning', () => {
    const { parts } = translate(fixture('thoughts-turn-1.ndjson'), undefined)
    assert.ok(!parts.some((p) => p.type.startsWith('reasoning-')))
  })
})

describe('the harness reads them after each turn', () => {
  const start = (sandbox: ReturnType<typeof fakeSandbox>) =>
    createAntigravity({ auth: { GEMINI_API_KEY: 'AIza-test' } }).doStart({
      sessionId: 's1',
      sandboxSession: sandbox as never,
      sessionWorkDir: '/reeval/workspace',
      permissionMode: 'allow-all',
    })

  test("from the conversation's store in the sandbox's home, from the turn's first step", async () => {
    const sandbox = fakeSandbox({
      turns: [{ stdout: fixture('thoughts-turn-1.ndjson') }],
      run: () => ({ exitCode: 0, stdout: JSON.stringify(THOUGHTS), stderr: '' }),
    })
    const parts = visible(await runTurn(await start(sandbox), 'go'))
    const read = sandbox.ran.filter((c) => c.startsWith("'node' "))
    assert.equal(read.length, 1)
    assert.match(
      read[0] ?? '',
      new RegExp(`'/root/\\.gemini/antigravity-cli' '${CONVERSATION}' '1'$`),
    )
    const types = parts.map((p) => p.type)
    assert.ok(types.includes('reasoning-delta'))
    assert.ok(types.indexOf('reasoning-end') < types.indexOf('finish'))
  })

  test('a store it cannot read leaves the turn as it was', async () => {
    const sandbox = fakeSandbox({
      turns: [{ stdout: fixture('thoughts-turn-1.ndjson') }],
      run: () => {
        throw new Error('the sandbox is gone')
      },
    })
    const parts = visible(await runTurn(await start(sandbox), 'go'))
    assert.ok(!parts.some((p) => p.type.startsWith('reasoning-')))
    assert.equal(parts.at(-1)?.type, 'finish')
  })

  test('an aborted turn reads nothing', async () => {
    const sandbox = fakeSandbox({
      turns: [{ stdout: fixture('thoughts-turn-1.ndjson') }],
      run: () => ({ exitCode: 0, stdout: JSON.stringify(THOUGHTS), stderr: '' }),
    })
    const abort = new AbortController()
    abort.abort()
    await runTurn(await start(sandbox), 'go', { abortSignal: abort.signal })
    assert.ok(!sandbox.ran.some((c) => c.startsWith("'node' ")))
  })
})
