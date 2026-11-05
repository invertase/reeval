import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { callUsage, type ModelCall, modelCallEvents } from '../src/model-calls.ts'
import type { TranscriptEvent } from '../src/types.ts'
import {
  inferDurations,
  segments,
  sumSplits,
  timeSplit,
  waitRoles,
  waitSpans,
} from '../src/view/timeline.ts'
import { fakeConfig, project, readRun, runCli } from './helpers.ts'

const at = (atMs: number) => ({ ts: new Date(atMs).toISOString(), atMs })
const tool = (
  atMs: number,
  name: string,
  input: unknown,
  durationMs: number | null = 10,
  output: unknown = '',
): TranscriptEvent => ({
  ...at(atMs),
  type: 'tool',
  toolCallId: `t${atMs}`,
  tool: name,
  input,
  output,
  ok: true,
  durationMs,
})
const model = (atMs: number, durationMs: number, stream = false): TranscriptEvent => ({
  ...at(atMs),
  type: 'model-call',
  request: 'POST api.anthropic.com/v1/messages',
  status: 200,
  durationMs,
  firstByteMs: 5,
  usage: null,
  model: null,
  ...(stream ? { stream: true as const } : {}),
})

/** A captured attempt's transcript.jsonl, its first turn's events. */
function captured(harness: string): { events: TranscriptEvent[]; turnMs: number } {
  const run = join(
    import.meta.dirname,
    'fixtures/records/before-time-split/evals/.history/20261105T124838Z_nogit_cursor-agent_bxp9/probe-eval-ts-slow-install-d3cb47',
  )
  const dir = readdirSync(run).find((d) => d.startsWith(harness))
  assert.ok(dir)
  const lines = readFileSync(join(run, dir, '1', 'transcript.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  const end = lines.find((l) => l.type === 'turn-end')
  const events = lines
    .filter((l) => l.type !== 'prompt' && l.type !== 'turn-end')
    .map(({ turn: _, ...e }) => e as TranscriptEvent)
  return { events, turnMs: Number(end?.durationMs) }
}

describe('callUsage', () => {
  test("Anthropic's input leaves the cache out", () => {
    assert.deepEqual(
      callUsage({
        input_tokens: 12,
        output_tokens: 250,
        cache_read_input_tokens: 400,
        cache_creation_input_tokens: 30,
      }),
      { input: 12, output: 250, cacheRead: 400, cacheWrite: 30, reasoning: null },
    )
  })
  test("OpenAI's and Gemini's prompt counts include cache reads", () => {
    assert.deepEqual(
      callUsage({ input_tokens: 100, cached_tokens: 60, output_tokens: 9, reasoning_tokens: 4 }),
      { input: 40, output: 9, cacheRead: 60, cacheWrite: 0, reasoning: 4 },
    )
    assert.deepEqual(callUsage({ prompt_tokens: 50, completion_tokens: 7 }), {
      input: 50,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: null,
    })
    assert.deepEqual(
      callUsage({
        promptTokenCount: 80,
        cachedContentTokenCount: 20,
        candidatesTokenCount: 10,
        thoughtsTokenCount: 5,
      }),
      { input: 60, output: 15, cacheRead: 20, cacheWrite: 0, reasoning: 5 },
    )
  })
  test('none named is null', () => {
    assert.equal(callUsage(undefined), null)
    assert.equal(callUsage({}), null)
  })
})

describe('modelCallEvents', () => {
  const call = (startedAt: number, stream?: true): ModelCall => ({
    startedAt,
    ms: 400,
    firstByteMs: 90,
    request: 'POST api2.cursor.sh/agent.v1.AgentService/RunSSE',
    status: 200,
    usage: null,
    model: null,
    ...(stream ? { stream } : {}),
  })
  test('places the calls that started in the turn on its clock', () => {
    const events = modelCallEvents([call(900), call(1500, true), call(9000)], 1000, 2000)
    assert.deepEqual(events, [
      {
        ts: new Date(1500).toISOString(),
        atMs: 500,
        type: 'model-call',
        request: 'POST api2.cursor.sh/agent.v1.AgentService/RunSSE',
        status: 200,
        durationMs: 400,
        firstByteMs: 90,
        usage: null,
        model: null,
        stream: true,
      },
    ])
  })
})

describe('inferDurations', () => {
  test('a call with no reported end runs to the next event, the last to the turn end', () => {
    const events = inferDurations(
      [
        tool(100, 'read', {}, null),
        model(150, 10),
        tool(400, 'read', {}),
        tool(700, 'grep', {}, null),
      ],
      1000,
    )
    assert.deepEqual(
      events.map((e) => ('durationMs' in e ? [e.durationMs, 'durationInferred' in e] : null)),
      [
        [300, true],
        [10, false],
        [10, false],
        [300, true],
      ],
    )
  })
})

describe('waitSpans and timeSplit', () => {
  test('a backgrounded command, then polls, is waiting until the last poll ends', () => {
    const events = [
      tool(0, 'Bash', { command: './install.sh', run_in_background: true }, 20),
      tool(100, 'Bash', { command: 'sleep 30' }, 30_000),
      tool(30_200, 'BashOutput', { bash_id: 'b1' }, 50),
      tool(31_000, 'Read', { file_path: 'done.txt' }, 100),
    ]
    assert.deepEqual(
      waitSpans(events).map(({ startMs, endMs }) => [startMs, endMs]),
      [[0, 30_250]],
    )
    assert.deepEqual(
      [...waitRoles(events)],
      [
        [0, 'background'],
        [1, 'poll'],
        [2, 'poll'],
      ],
    )
    assert.deepEqual(timeSplit(events, 32_000), {
      modelMs: null,
      toolMs: 100,
      waitingMs: 30_250,
      otherMs: 1650,
    })
  })

  test('a backgrounded sleep starts a job rather than polling one', () => {
    const events = [
      tool(0, 'shell', { command: 'sleep 5 > /dev/null 2>&1 &' }, 5),
      tool(10, 'shell', { command: 'sleep 1' }, 1000),
    ]
    assert.deepEqual(
      [...waitRoles(events)],
      [
        [0, 'background'],
        [1, 'poll'],
      ],
    )
  })

  test('a backgrounded server no poll checked on is not waiting', () => {
    const events = [
      tool(0, 'shell', { command: 'npm run dev &' }, 20),
      {
        ...at(100),
        type: 'file-edit',
        toolCallId: 'e1',
        path: 'a.ts',
        kind: 'modify',
        added: 1,
        removed: 0,
        durationMs: 20,
      },
      tool(200, 'shell', { command: 'sleep 1' }, 1000),
    ]
    assert.deepEqual(
      waitSpans(events).map(({ startMs, background }) => [startMs, background]),
      [[200, null]],
    )
  })

  test('model calls count when no tool or wait covers them; a stream never does', () => {
    const events = [
      model(0, 500),
      tool(400, 'read', {}, 200),
      model(600, 300),
      model(0, 5000, true),
    ]
    assert.deepEqual(segments(events, 1000), [
      { kind: 'model', startMs: 0, endMs: 400 },
      { kind: 'tool', startMs: 400, endMs: 600 },
      { kind: 'model', startMs: 600, endMs: 900 },
      { kind: 'other', startMs: 900, endMs: 1000 },
    ])
    assert.deepEqual(timeSplit(events, 1000), {
      modelMs: 700,
      toolMs: 200,
      waitingMs: 0,
      otherMs: 100,
    })
  })

  test("Cursor's captured turn: the background install, its terminal-file polls", () => {
    const { events, turnMs } = captured('cursor')
    const [span] = waitSpans(events)
    assert.equal(waitSpans(events).length, 1)
    assert.equal(span?.startMs, 5723)
    assert.equal(span?.endMs, 113_086 + 37)
    const split = timeSplit(events, turnMs)
    assert.equal(split.modelMs, null)
    assert.equal(split.waitingMs, 113_123 - 5723)
    assert.equal(split.waitingMs + split.toolMs + split.otherMs, turnMs)
  })

  test("Claude Code's captured turn ended on ScheduleWakeup, before any poll", () => {
    const { events, turnMs } = captured('claude-code')
    assert.deepEqual(waitSpans(events), [])
    const split = timeSplit(events, turnMs)
    assert.equal(split.waitingMs, 0)
    assert.equal(split.toolMs + split.otherMs, turnMs)
  })

  test('sumSplits adds the turns; model time unknown in one is unknown in all', () => {
    const a = { modelMs: 10, toolMs: 1, waitingMs: 2, otherMs: 3 }
    assert.deepEqual(sumSplits([a, a]), { modelMs: 20, toolMs: 2, waitingMs: 4, otherMs: 6 })
    assert.equal(sumSplits([a, { ...a, modelMs: null }])?.modelMs, null)
    assert.equal(sumSplits([undefined]), undefined)
  })
})

describe('a run records where each turn went', () => {
  test('waiting on a backgrounded job, and a tool call whose end was never reported', async () => {
    const harness = `{
      tools: [{ tool: 'read', input: { path: 'a.txt' }, output: '', durationMs: null }],
      script: [[{ exec: 'sleep 2 > /dev/null 2>&1 &' }, { exec: 'sleep 1' }]],
    }`
    const p = await project('time-split', {
      'reeval.config.ts': fakeConfig({ harness }),
      'evals/w.eval.ts': `import { evaluate } from 'reeval'
evaluate('waits', async (c) => {
  await c.send('go')
})
`,
    })
    const run = await runCli(p.dir)
    assert.equal(run.code, 0, run.stdout + run.stderr)
    const { evals, read } = readRun(p.dir)
    const attempt = evals[0]?.trial
    assert.ok(attempt?.timeSplit)
    const turn = attempt.turns[0]
    assert.deepEqual(attempt.timeSplit, turn?.timeSplit)
    const { modelMs, toolMs, waitingMs, otherMs } = attempt.timeSplit
    assert.equal(modelMs, null, 'the fake sandbox has no gateway to see model calls')
    assert.ok(waitingMs >= 1000, `waited ${waitingMs}ms`)
    assert.equal(toolMs + waitingMs + otherMs, turn?.durationMs)
    assert.ok(attempt.files.transcript)
    const transcript = read(attempt.files.transcript.path)
    const readCall = transcript
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((e) => e.tool === 'read')
    assert.equal(readCall.durationInferred, true)
    assert.equal(typeof readCall.durationMs, 'number')
    assert.match(read('summary.md'), /- Agent time: tools .* · waiting [\d.]+s · other /)
    const effort = await runCli(p.dir, [
      'query',
      'SELECT model_s_median, waiting_s_median FROM effort',
      '--json',
    ])
    assert.equal(effort.code, 0, effort.stderr)
    const [row] = JSON.parse(effort.stdout)
    assert.equal(row.model_s_median, null)
    assert.ok(row.waiting_s_median >= 1, JSON.stringify(row))
  })
})
