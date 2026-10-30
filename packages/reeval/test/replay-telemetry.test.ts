// Replays one real edit-and-reason turn per harness (test/replay/telemetry/, recorded with
// REEVAL_RAW_TRANSCRIPT=1 on a two-file edit eval) through today's normalizer and the catalog's
// reasoning delivery: every harness's edits are counted, a reasoning time is a measurement only
// where the harness streams its reasoning, and a time it can't measure is null, never 0.
// `<harness>-subagent` captures had the agent hand the edits to a subagent.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { CodexStreamTranslator } from '@reeval/harness-codex'
import { tokenUsage } from '../src/harness/agent.ts'
import { AGENTS } from '../src/harness/agents.ts'
import { normalizeStream, reasoningTime } from '../src/harness/transcript.ts'
import type { TranscriptEvent } from '../src/types.ts'
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
  antigravity: null,
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
    .filter((n) => !n.endsWith('-subagent'))
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
  for (const harness of ['codex', 'antigravity', 'opencode'] as const) {
    const lines = parse(read(harness))
    assert.ok((usageOf(lines)?.reasoning ?? 0) > 0, `${harness} billed reasoning tokens`)
    assert.equal(reasoningMs(harness, lines), null, harness)
  }
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
