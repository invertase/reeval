// Replays real agent streams, captured from the contract suite (test/replay/<harness>/, refreshed
// with ES_UPDATE_CAPTURES=1 on a real run), through today's code, key-free: ES's normaliser must
// still find each behaviour's signals, Antigravity's adapter must still translate the native events
// to the same tool calls, text and token counts, and every native event must match the committed
// format (test/replay/formats/). Each check has a twin that proves it can fail.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { HarnessV1StreamPart } from '@ai-sdk/harness'
import { AntigravityStreamTranslator } from '@evalsuite/harness-antigravity'
import { normaliseStream } from '../src/harness/transcript.ts'
import type { TranscriptEvent } from '../src/types.ts'
import { testDir } from './support/fixture.ts'
import { knownSignatures, nativeEvents, signatures } from './support/stream-formats.ts'

type Line = { turn: number; ms: number; part: { type: string; [k: string]: unknown } }
const root = join(testDir, 'replay')
const read = (harness: string, name: string) => readFileSync(join(root, harness, name), 'utf8')
const parse = (text: string): Line[] =>
  text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line)
const events = (lines: Line[]) =>
  normaliseStream(
    lines.map((l) => ({ ms: l.ms, part: l.part as never })),
    0,
  )

const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''))
const tools = (es: TranscriptEvent[]) => es.flatMap((e) => (e.type === 'tool' ? [e] : []))
const edits = (es: TranscriptEvent[]) => es.flatMap((e) => (e.type === 'file-edit' ? [e] : []))

/** What each captured behaviour's stream must still say once normalised: robust signals only. */
const signals: Record<string, (es: TranscriptEvent[]) => void> = {
  skill(es) {
    assert.ok(
      tools(es).some((t) => text(t.input).includes('contract-probe/SKILL.md')),
      'the agent read the skill',
    )
    assert.ok(edits(es).some((e) => e.path === 'skill-proof.txt'))
  },
  mcp(es) {
    assert.ok(tools(es).some((t) => t.tool === 'mcp__stamp__house_stamp'))
  },
  'edit-and-run'(es) {
    assert.ok(edits(es).some((e) => e.path === 'notes.txt' && e.kind === 'modify'))
    assert.ok(tools(es).some((t) => text(t.output).includes('contract-42')))
  },
  egress(es) {
    assert.ok(tools(es).some((t) => text(t.input).includes('https://example.com/')))
  },
}

const harnesses = existsSync(root)
  ? readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'formats')
      .map((d) => d.name)
  : []

test('there are captures for Cursor and Antigravity', () => {
  assert.deepEqual(harnesses.sort(), ['antigravity', 'cursor'])
})

for (const harness of harnesses) {
  describe(`replay: ${harness}`, () => {
    const files = readdirSync(join(root, harness)).filter((f) => f.endsWith('.raw.jsonl'))
    test('one capture per behaviour', () => {
      assert.deepEqual(
        files.map((f) => f.replace('.raw.jsonl', '')).sort(),
        Object.keys(signals).sort(),
      )
    })
    for (const file of files) {
      const name = file.replace('.raw.jsonl', '')
      test(`${name}: ES's normaliser still finds its signals`, () => {
        const check = signals[name]
        assert.ok(check, `no signals for ${name}`)
        check(events(parse(read(harness, file))))
      })
    }
    test('twin: a capture checked for another behaviour fails', () => {
      assert.throws(() => signals.mcp?.(events(parse(read(harness, 'skill.raw.jsonl')))))
    })
  })
}

describe('replay: the Antigravity adapter, from the CLI’s own events', () => {
  /** The native events through today's translator, as its parts (raw ones dropped). */
  const retranslate = (lines: Line[]) => {
    const t = new AntigravityStreamTranslator({ turn: 1 })
    const parts: HarnessV1StreamPart[] = []
    for (const e of nativeEvents(lines.map((l) => JSON.stringify(l)).join('\n')))
      parts.push(...t.push(JSON.stringify(e)))
    return parts.filter((p) => p.type !== 'raw')
  }
  /** What must match between the captured parts and today's: tool calls, text and token totals. */
  const essence = (parts: Array<{ type: string; [k: string]: unknown }>) => ({
    calls: parts
      .filter((p) => p.type === 'tool-call')
      .map((p) => [
        p.toolName,
        // The harness layer makes paths workspace-relative after the adapter.
        JSON.parse(text(p.input).replaceAll('/es/workspace/', '')),
      ]),
    text: parts
      .filter((p) => p.type === 'text-delta')
      .map((p) => p.delta ?? p.text)
      .join(''),
    tokens: (() => {
      const u = parts.find((p) => p.type === 'finish')?.totalUsage as
        | { raw?: { input_tokens?: number; output_tokens?: number } }
        | undefined
      return [u?.raw?.input_tokens, u?.raw?.output_tokens]
    })(),
  })

  for (const file of readdirSync(join(root, 'antigravity')).filter((f) => f.endsWith('.jsonl'))) {
    test(`${file}: the same tool calls, text and tokens as when it was captured`, () => {
      const lines = parse(read('antigravity', file))
      const captured = essence(lines.map((l) => l.part))
      assert.ok(captured.calls.length > 0 && captured.tokens[0], 'the capture has calls and tokens')
      assert.deepEqual(essence(retranslate(lines) as never), captured)
    })
  }

  test('twin: a changed event changes the translation', () => {
    const lines = parse(
      read('antigravity', 'edit-and-run.raw.jsonl').replaceAll('"run_command"', '"run_cmd_v2"'),
    )
    const captured = essence(
      parse(read('antigravity', 'edit-and-run.raw.jsonl')).map((l) => l.part),
    )
    assert.notDeepEqual(essence(retranslate(lines) as never).calls, captured.calls)
  })
})

describe('replay: native stream formats', () => {
  test('every captured Antigravity event matches the committed format', () => {
    const known = new Set(knownSignatures('antigravity'))
    assert.ok(known.size > 0, 'test/replay/formats/antigravity.json is empty')
    for (const file of readdirSync(join(root, 'antigravity'))) {
      const seen = signatures('antigravity', nativeEvents(read('antigravity', file)))
      assert.deepEqual(
        seen.filter((s) => !known.has(s)),
        [],
        file,
      )
    }
  })

  test('twin: a new event kind, step type, key or tool is a format change', () => {
    const known = new Set(knownSignatures('antigravity'))
    const base = read('antigravity', 'edit-and-run.raw.jsonl')
    for (const [from, to] of [
      ['"event":"result"', '"event":"final_result"'],
      ['"step_type":"tool"', '"step_type":"tool_v2"'],
      ['"text_delta"', '"delta_text"'],
      ['"run_command"', '"run_cmd_v2"'],
      ['"state":"DONE"', '"state":"FINISHED"'],
    ] as const) {
      const changed = base.replaceAll(from, to)
      assert.notEqual(changed, base, `${from} is in the capture`)
      const unknown = signatures('antigravity', nativeEvents(changed)).filter((s) => !known.has(s))
      assert.notDeepEqual(unknown, [], `${from} → ${to} went unnoticed`)
    }
  })
})
