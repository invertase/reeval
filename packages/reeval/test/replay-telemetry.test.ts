// Replays one real edit-and-reason turn per harness (test/replay/telemetry/, recorded with
// REEVAL_RAW_TRANSCRIPT=1 on a two-file edit eval) through today's normalizer and the catalog's
// reasoning delivery: every harness's edits are counted, a reasoning time is a measurement only
// where the harness streams its reasoning or recovers it with its time, and a time it can't
// measure is null, never 0.
// `<harness>-subagent` captures had the agent hand the edits to a subagent.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { harnessUsage, reasoningTime } from '@reeval/agents'
import { CodexStreamTranslator } from '@reeval/harness-codex'
import { AGENTS } from '../src/harness/agents.ts'
import { normalizeStream } from '../src/harness/transcript.ts'
import type { TranscriptEvent } from '../src/types.ts'
import { tokenUsage } from '../src/usage.ts'
import { testDir } from './support/fixture.ts'
import { nativeEvents } from './support/stream-formats.ts'

type Part = { type: string; [k: string]: unknown }
type Line = { ms: number; part: Part }
const dir = join(testDir, 'replay', 'telemetry')
const read = (name: string) => readFileSync(join(dir, `${name}.raw.jsonl`), 'utf8')
const parse = (text: string): Line[] =>
  text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line)
const normalize = (lines: Line[]) =>
  normalizeStream(
    lines.map((l) => ({ ms: l.ms, part: l.part as never })),
    0,
  )
const usageOf = (lines: Line[]) => {
  const finish = lines.findLast((l) => l.part.type === 'finish')?.part
  return finish ? tokenUsage(finish.totalUsage as never) : null
}
const edits = (events: TranscriptEvent[]) =>
  events.flatMap((e) => (e.type === 'file-edit' ? [e] : []))
const reasoningMs = (harness: keyof typeof AGENTS, lines: Line[]) =>
  reasoningTime(AGENTS[harness].reasoning, normalize(lines), usageOf(lines))

/** Each harness's reasoning time on its capture: measured (`> 0`) or unknown (`null`). */
const REASONING: Record<keyof typeof AGENTS, 'measured' | null> = {
  cursor: 'measured',
  'claude-code': 'measured',
  antigravity: 'measured',
  opencode: null,
  goose: 'measured',
  pi: 'measured',
  codex: null,
  fx: null,
  'grok-build': 'measured',
}

test('there is a capture for every harness in the catalog', () => {
  const captured = readdirSync(dir)
    .map((f) => f.replace('.raw.jsonl', ''))
    .filter((n) => !n.endsWith('-subagent') && !n.endsWith('-reasoning'))
  assert.deepEqual(captured.sort(), Object.keys(AGENTS).sort())
})

for (const harness of Object.keys(AGENTS) as Array<keyof typeof AGENTS>)
  describe(`telemetry: ${harness}`, () => {
    const lines = parse(read(harness))
    test('the edit eval counts both edits', () => {
      assert.deepEqual(
        edits(normalize(lines))
          .map((e) => e.path)
          .sort(),
        ['src/NOTES.md', 'src/schedule.js'],
      )
    })
    test(
      REASONING[harness]
        ? 'its streamed reasoning is timed'
        : "reasoning time it can't measure is null",
      () => {
        const ms = reasoningMs(harness, lines)
        if (REASONING[harness]) assert.ok(typeof ms === 'number' && ms > 0, `${ms}`)
        else assert.equal(ms, null)
      },
    )
  })

test('a harness that bills reasoning tokens without showing it reports no reasoning time', () => {
  for (const harness of ['codex', 'opencode'] as const) {
    const lines = parse(read(harness))
    assert.ok((usageOf(lines)?.reasoning ?? 0) > 0, `${harness} billed reasoning tokens`)
    assert.equal(reasoningMs(harness, lines), null, harness)
  }
})

describe("telemetry: Antigravity's reasoning, recovered from agy's stored conversation", () => {
  const lines = parse(read('antigravity'))
  const events = normalize(lines)
  const recovered = lines.flatMap(({ part }) =>
    part.type === 'reasoning-start'
      ? [(part.providerMetadata as { antigravity: { durationMs: number } }).antigravity]
      : [],
  )
  test("each block has its text and agy's thinking_duration", () => {
    const blocks = events.flatMap((e) => (e.type === 'reasoning' ? [e] : []))
    assert.ok(blocks.length > 0)
    assert.deepEqual(
      blocks.map((b) => b.durationMs),
      recovered.map((r) => r.durationMs),
    )
    for (const b of blocks) assert.ok(b.text.trim(), 'a block with no text')
    assert.equal(
      reasoningMs('antigravity', lines),
      recovered.reduce((n, r) => n + r.durationMs, 0),
    )
  })
  test('each block sits where the model thought, ahead of what its step did', () => {
    // Recovered after the turn, every block arrived with the result: it's placed by its metadata.
    const arrived = lines.find((l) => l.part.type === 'reasoning-start')?.ms ?? 0
    for (const [i, e] of events.entries()) {
      if (e.type !== 'reasoning') continue
      assert.ok(e.atMs < arrived, `${e.atMs} is where it arrived`)
      const next = events[i + 1]
      assert.ok(next && next.type !== 'reasoning' && next.atMs >= e.atMs + (e.durationMs ?? 0))
    }
  })
  test('twin: a store it could not read leaves the time unknown, not 0', () => {
    const without = lines.filter((l) => !l.part.type.startsWith('reasoning-'))
    assert.ok((usageOf(without)?.reasoning ?? 0) > 0)
    assert.equal(reasoningMs('antigravity', without), null)
  })
})

test('twin: the same capture read as streamed reasons for 0 ms, not null', () => {
  const lines = parse(read('fx'))
  const events = normalize(lines)
  assert.equal(reasoningTime('streamed', events, { ...usageOf(lines), reasoning: 0 } as never), 0)
  assert.equal(reasoningTime('none', events, null), null)
})

test('twin: a streamed block with no end is unknown, not 0', () => {
  const events = normalize(parse(read('cursor')))
  const open = events.map((e) => (e.type === 'reasoning' ? { ...e, durationMs: null } : e))
  assert.ok(open.some((e) => e.type === 'reasoning'))
  assert.equal(reasoningTime('streamed', open, null), null)
})

// `<harness>-reasoning` captures are a one-turn edit eval on the settings that ask for the model's
// reasoning: Claude Code's bridge counting thinking tokens, Codex with `model_reasoning_summary`,
// and OpenCode on Gemini at `high` with `includeThoughts`. Each twin is the same harness's capture
// above, from before those settings.
const reasoningText = (events: TranscriptEvent[]) =>
  events.reduce((n, e) => n + (e.type === 'reasoning' ? e.text.length : 0), 0)

describe("telemetry: the model's reasoning where the harness gets it", () => {
  test("Claude Code counts the turn's thinking tokens apart", () => {
    assert.equal(AGENTS['claude-code'].reasoningTokens, true)
    const usage = usageOf(parse(read('claude-code-reasoning')))
    assert.equal(usage?.reasoning, 87)
    assert.equal(usage?.output, 830)
  })
  test('twin: a bridge that drops them records no reasoning tokens', () => {
    assert.equal(usageOf(parse(read('claude-code')))?.reasoning, null)
  })

  test("Codex's reasoning summaries reach the transcript, whole", () => {
    const lines = parse(read('codex-reasoning'))
    assert.ok(reasoningText(normalize(lines)) > 0)
    const t = new CodexStreamTranslator({ workDir: '/reeval/workspace' })
    const retranslated = normalize(
      nativeEvents(read('codex-reasoning'))
        .flatMap((e) => t.push(JSON.stringify(e)))
        .map((part, ms) => ({ ms, part: part as Part })),
    )
    assert.equal(reasoningText(retranslated), reasoningText(normalize(lines)))
    assert.ok((usageOf(lines)?.reasoning ?? 0) > 0)
    assert.equal(reasoningMs('codex', lines), null)
  })
  test('twin: without a summary, Codex reasons with no text', () => {
    const lines = parse(read('codex'))
    assert.ok((usageOf(lines)?.reasoning ?? 0) > 0)
    assert.equal(reasoningText(normalize(lines)), 0)
  })

  test("OpenCode on Gemini streams the model's thoughts at an effort", () => {
    const lines = parse(read('opencode-reasoning'))
    assert.ok(reasoningText(normalize(lines)) > 0)
    assert.ok((usageOf(lines)?.reasoning ?? 0) > 0)
    const ms = reasoningMs('opencode', lines)
    assert.ok(typeof ms === 'number' && ms > 0, `${ms}`)
  })
  test('twin: an effort without includeThoughts bills thoughts it never shows', () => {
    const lines = parse(read('opencode'))
    assert.ok((usageOf(lines)?.reasoning ?? 0) > 0)
    assert.equal(reasoningText(normalize(lines)), 0)
  })
})

describe("telemetry: Claude Code's edits through a subagent", () => {
  const lines = parse(read('claude-code-subagent'))
  const events = normalize(lines)
  const agent = events.find((e) => e.type === 'tool' && e.tool === 'Agent')
  test("the subagent's edits are counted, each naming the Agent call", () => {
    assert.ok(agent?.type === 'tool')
    const found = edits(events)
    assert.deepEqual(found.map((e) => e.path).sort(), ['src/NOTES.md', 'src/schedule.js'])
    for (const e of found) assert.equal(e.subagent, agent.toolCallId)
  })
  test('twin: without the subagent messages there are no edits', () => {
    const own = lines.filter(
      (l) =>
        l.part.type !== 'raw' ||
        !(l.part.rawValue as { parent_tool_use_id?: string })?.parent_tool_use_id,
    )
    assert.deepEqual(edits(normalize(own)), [])
  })
})

describe("telemetry: Codex's subagent calls", () => {
  const retranslate = (raw: string) => {
    const t = new CodexStreamTranslator({ workDir: '/reeval/workspace' })
    return nativeEvents(raw).flatMap((e) => t.push(JSON.stringify(e)))
  }
  const calls = (raw: string) =>
    retranslate(raw).flatMap((p) => (p.type === 'tool-call' ? [p.toolName] : []))
  test('spawn_agent and wait are tool calls', () => {
    const names = calls(read('codex-subagent'))
    assert.ok(names.includes('spawn_agent'), names.join())
    assert.ok(names.includes('wait'), names.join())
  })
  test('twin: an unknown collab item is not one', () => {
    const raw = read('codex-subagent').replaceAll('"collab_tool_call"', '"collab_unknown"')
    assert.deepEqual(calls(raw), [])
  })
})

describe("telemetry: usage read back from a CLI's store", () => {
  test('the harnesses that store usage per model call read it back, the others none', () => {
    const readers = Object.entries(AGENTS).flatMap(([id, a]) => ('storedUsage' in a ? [id] : []))
    assert.deepEqual(readers.sort(), ['codex', 'goose', 'grok-build', 'opencode'])
  })
  test("a store's counts are reeval's: input uncached, reasoning inside the output", () => {
    assert.deepEqual(
      harnessUsage({
        inputTokens: { total: 116_749, noCache: 15, cacheRead: 101_399, cacheWrite: 15_335 },
        outputTokens: { total: 338, text: 218, reasoning: 120 },
      }),
      { input: 15, output: 338, cacheRead: 101_399, cacheWrite: 15_335, reasoning: 120 },
    )
    assert.deepEqual(
      harnessUsage({
        inputTokens: { total: 10_623, noCache: undefined, cacheRead: 3900, cacheWrite: undefined },
        outputTokens: { total: 1847, text: undefined, reasoning: undefined },
      }),
      { input: 6723, output: 1847, cacheRead: 3900, cacheWrite: 0, reasoning: null },
    )
  })
  test('twin: a store that counted nothing is no usage, not zero', () => {
    const none = { total: undefined, noCache: undefined, cacheRead: undefined }
    assert.equal(
      harnessUsage({
        inputTokens: { ...none, cacheWrite: undefined },
        outputTokens: { total: undefined, text: undefined, reasoning: undefined },
      }),
      null,
    )
  })
})
