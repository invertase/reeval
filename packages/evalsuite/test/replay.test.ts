// Replays real agent streams, captured from the contract suite (test/replay/<harness>/, refreshed
// with ES_UPDATE_CAPTURES=1 on a real run), through today's code, key-free: ES's normaliser must
// still find each behaviour's signals, each adapter (Antigravity, the Cursor SDK) must still translate the native events
// to the same tool calls, text and token counts, and every native event must match the committed
// format (test/replay/formats/). Each check has a twin that proves it can fail.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { HarnessV1StreamPart } from '@ai-sdk/harness'
import { AntigravityStreamTranslator } from '@evalsuite/harness-antigravity'
import { CursorSdkStreamTranslator } from '@evalsuite/harness-cursor-sdk'
import { GooseStreamTranslator } from '@evalsuite/harness-goose'
import { OpenCodeStreamTranslator } from '@evalsuite/harness-opencode'
import { PiStreamTranslator } from '@evalsuite/harness-pi'
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
    // It read the file, or loaded it with its skill tool (OpenCode's `skill`, Goose's
    // `load_skill`).
    assert.ok(
      tools(es).some(
        (t) =>
          text(t.input).includes('contract-probe/SKILL.md') ||
          ((t.tool === 'skill' || t.tool === 'load_skill') &&
            text(t.input).includes('"contract-probe"')),
      ),
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

const NO_MCP = new Set(['pi'])

const harnesses = existsSync(root)
  ? readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'formats')
      .map((d) => d.name)
  : []

test('there are captures for Cursor, Antigravity, OpenCode, Goose and pi', () => {
  assert.deepEqual(harnesses.sort(), ['antigravity', 'cursor', 'goose', 'opencode', 'pi'])
})

for (const harness of harnesses) {
  describe(`replay: ${harness}`, () => {
    const files = readdirSync(join(root, harness)).filter((f) => f.endsWith('.raw.jsonl'))
    test('one capture per behaviour', () => {
      // A harness with no MCP client has no MCP capture: its MCP attempts are refused.
      const behaviours = Object.keys(signals).filter((b) => b !== 'mcp' || !NO_MCP.has(harness))
      assert.deepEqual(files.map((f) => f.replace('.raw.jsonl', '')).sort(), behaviours.sort())
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
      assert.throws(() => signals.egress?.(events(parse(read(harness, 'skill.raw.jsonl')))))
    })
  })
}

/** A native tool name in each harness's edit-and-run capture, and a name its adapter doesn't know. */
const renamedTool: Record<string, [string, string]> = {
  antigravity: ['"run_command"', '"run_cmd_v2"'],
  cursor: ['"name":"shell"', '"name":"shell_v2"'],
  pi: ['"name":"bash"', '"name":"bash_v2"'],
}

/** Each harness's translator, fresh for one turn: the native events go back through it. */
const translators: Record<string, () => { push(line: string): HarnessV1StreamPart[] }> = {
  antigravity: () => new AntigravityStreamTranslator({ turn: 1 }),
  cursor: () => new CursorSdkStreamTranslator({ workDir: '/es/workspace' }),
  pi: () => new PiStreamTranslator(),
}

for (const harness of Object.keys(translators))
  describe(`replay: the ${harness} adapter, from the agent’s own events`, () => {
    /** The native events through today's translator, as its parts (raw ones dropped). */
    const retranslate = (lines: Line[]) => {
      const t = (translators[harness] as () => { push(line: string): HarnessV1StreamPart[] })()
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
      // Captured parts carry the AI SDK's numbers; the translator's, `{ total }`.
      tokens: (() => {
        const u = parts.find((p) => p.type === 'finish')?.totalUsage as
          | Record<string, number | { total?: number } | undefined>
          | undefined
        const n = (v: number | { total?: number } | undefined) =>
          typeof v === 'number' ? v : v?.total
        return [n(u?.inputTokens), n(u?.outputTokens)]
      })(),
    })

    for (const file of readdirSync(join(root, harness)).filter((f) => f.endsWith('.jsonl'))) {
      test(`${file}: the same tool calls, text and tokens as when it was captured`, () => {
        const lines = parse(read(harness, file))
        const captured = essence(lines.map((l) => l.part))
        assert.ok(
          captured.calls.length > 0 && captured.tokens[0],
          'the capture has calls and tokens',
        )
        assert.deepEqual(essence(retranslate(lines) as never), captured)
      })
    }

    test('twin: a changed event changes the translation', () => {
      const [from, to] = renamedTool[harness] as [string, string]
      const base = read(harness, 'edit-and-run.raw.jsonl')
      assert.ok(base.includes(from), `${from} is in the capture`)
      const lines = parse(base.replaceAll(from, to))
      const captured = essence(parse(base).map((l) => l.part))
      assert.notDeepEqual(essence(retranslate(lines) as never).calls, captured.calls)
    })
  })

// OpenCode's ACP events become parts inside @ai-sdk/harness-acp's bridge, so only the adapter's
// own step replays: the names it gives calls the bridge couldn't name.
describe('replay: the OpenCode adapter, from the captured parts', () => {
  /** The captured parts as the bridge sends them: calls it couldn't name are `acp_tool_<id>`. */
  const fromBridge = (lines: Line[], named: Set<string>) =>
    lines.map((l) =>
      (l.part.type === 'tool-call' || l.part.type === 'tool-result') &&
      named.has(String(l.part.toolName))
        ? { ...l.part, toolName: `acp_tool_${l.part.toolCallId}` }
        : l.part,
    )
  const names = (parts: Array<{ type: string; [k: string]: unknown }>) =>
    parts.filter((p) => p.type === 'tool-call').map((p) => p.toolName)

  for (const [file, named, mcp] of [
    ['edit-and-run.raw.jsonl', 'bash', []],
    ['mcp.raw.jsonl', 'mcp__stamp__house_stamp', ['stamp']],
  ] as const) {
    test(`${file}: ${named} is named again from OpenCode's first update`, () => {
      const lines = parse(read('opencode', file))
      const captured = names(lines.map((l) => l.part))
      assert.ok(captured.includes(named), `${named} is in the capture`)
      const t = new OpenCodeStreamTranslator({ mcpServers: mcp })
      assert.deepEqual(names(fromBridge(lines, new Set([named])).map((p) => t.push(p))), captured)
    })
  }

  test('twin: without its first update, the call keeps the generic name', () => {
    const lines = parse(read('opencode', 'edit-and-run.raw.jsonl')).filter(
      (l) =>
        !(
          l.part.type === 'raw' &&
          (l.part.rawValue as { sessionUpdate?: string })?.sessionUpdate === 'tool_call'
        ),
    )
    const t = new OpenCodeStreamTranslator()
    const out = names(fromBridge(lines, new Set(['bash'])).map((p) => t.push(p)))
    assert.ok(
      out.some((n) => String(n).startsWith('acp_tool_')),
      JSON.stringify(out),
    )
  })
})

describe('replay: the Goose adapter, from the captured parts', () => {
  test('mcp.raw.jsonl: the MCP call is named again from its tool_call metadata', () => {
    const lines = parse(read('goose', 'mcp.raw.jsonl'))
    const named = 'mcp__stamp__house_stamp'
    const fromBridge = lines.map((l) =>
      (l.part.type === 'tool-call' || l.part.type === 'tool-result') && l.part.toolName === named
        ? { ...l.part, toolName: `acp_tool_${l.part.toolCallId}` }
        : l.part,
    )
    const calls = (parts: Array<{ type: string; [k: string]: unknown }>) =>
      parts.filter((p) => p.type === 'tool-call').map((p) => p.toolName)
    const t = new GooseStreamTranslator({ mcpServers: ['stamp'] })
    assert.deepEqual(calls(fromBridge.map((p) => t.push(p))), [named])
    const twin = new GooseStreamTranslator()
    assert.notDeepEqual(calls(fromBridge.map((p) => twin.push(p))), [named])
  })
})

/** Changes to each harness's native stream that must each read as a format change. */
const formatChanges: Record<string, Array<[string, string]>> = {
  antigravity: [
    ['"event":"result"', '"event":"final_result"'],
    ['"step_type":"tool"', '"step_type":"tool_v2"'],
    ['"text_delta"', '"delta_text"'],
    ['"run_command"', '"run_cmd_v2"'],
    ['"state":"DONE"', '"state":"FINISHED"'],
  ],
  cursor: [
    ['"type":"result"', '"type":"final_result"'],
    ['"type":"tool_call"', '"type":"tool_use"'],
    ['"call_id"', '"callId"'],
    ['"status":"completed"', '"status":"done"'],
  ],
  pi: [
    ['"type":"message_end"', '"type":"message_done"'],
    ['"type":"toolcall_end"', '"type":"tool_call_end"'],
    ['"stopReason":"toolUse"', '"stopReason":"tool_use"'],
  ],
  goose: [
    ['"sessionUpdate":"tool_call"', '"sessionUpdate":"tool_use"'],
    ['"stopReason"', '"stop_reason"'],
    ['"status":"completed"', '"status":"done"'],
  ],
  opencode: [
    ['"sessionUpdate":"tool_call"', '"sessionUpdate":"tool_use"'],
    ['"stopReason"', '"stop_reason"'],
    ['"kind":"execute"', '"kind":"shell"'],
    ['"status":"in_progress"', '"status":"running"'],
  ],
}

for (const harness of Object.keys(formatChanges))
  describe(`replay: ${harness}'s native stream format`, () => {
    const known = new Set(knownSignatures(harness))
    test('every captured event matches the committed format', () => {
      assert.ok(known.size > 0, `test/replay/formats/${harness}.json is empty`)
      for (const file of readdirSync(join(root, harness))) {
        const seen = signatures(harness, nativeEvents(read(harness, file)))
        assert.deepEqual(
          seen.filter((s) => !known.has(s)),
          [],
          file,
        )
      }
    })

    test('twin: a new event kind, step type, key or tool is a format change', () => {
      const base = read(harness, 'edit-and-run.raw.jsonl')
      for (const [from, to] of formatChanges[harness] ?? []) {
        const changed = base.replaceAll(from, to)
        assert.notEqual(changed, base, `${from} is in the capture`)
        const unknown = signatures(harness, nativeEvents(changed)).filter((s) => !known.has(s))
        assert.notDeepEqual(unknown, [], `${from} → ${to} went unnoticed`)
      }
    })
  })

describe('replay: Cursor web calls, streamed and recovered', () => {
  // A real two-turn capture where SDK 1.0.32 streamed no web calls and the runner recovered them
  // from Agent.messages.list(); its first turn only (up to the first result line).
  const capture = readFileSync(
    join(testDir, '../../harness-cursor-sdk/test/fixtures/web-recovered.ndjson'),
    'utf8',
  )
  const firstTurn = capture.split('\n').filter(Boolean)
  firstTurn.splice(firstTurn.findIndex((l) => JSON.parse(l).type === 'result') + 1)
  const recovered = firstTurn.filter((l) => JSON.parse(l).recovered)

  /** The turn as if the SDK streamed the web calls too, before the runner's recovered copies. */
  const upstreamFixed = (id: (callId: string) => string, keepMarker = true) => {
    const streamed = recovered.map((l) => {
      const { recovered: _, ...line } = JSON.parse(l)
      return JSON.stringify({ ...line, event: { ...line.event, call_id: id(line.event.call_id) } })
    })
    const usage = firstTurn.findIndex((l) => JSON.parse(l).event?.type === 'usage')
    const lines = [...firstTurn.slice(0, usage), ...streamed, ...firstTurn.slice(usage)]
    return keepMarker
      ? lines
      : lines.map((l) => JSON.stringify({ ...JSON.parse(l), recovered: undefined }))
  }
  const webCalls = (lines: string[]) => {
    const t = new CursorSdkStreamTranslator({ workDir: '/es/workspace' })
    return lines
      .flatMap((l) => t.push(l))
      .flatMap((p) => (p.type === 'tool-call' ? [p.toolName] : []))
      .filter((n) => n === 'webFetch' || n === 'webSearch')
      .sort()
  }

  test('today: the stream has none, the recovered calls are each reported once', () => {
    assert.ok(recovered.length > 0, 'the capture has recovered calls')
    assert.deepEqual(webCalls(firstTurn), ['webFetch', 'webSearch'])
  })

  test('upstream fixed, same ids: each web call once, not twice', () => {
    assert.deepEqual(webCalls(upstreamFixed((id) => id)), ['webFetch', 'webSearch'])
  })

  test('upstream fixed, other ids: each web call once, matched by tool and target', () => {
    assert.deepEqual(webCalls(upstreamFixed((id) => `${id}-streamed`)), ['webFetch', 'webSearch'])
  })

  test('twin: without the recovered marker, the same lines count twice', () => {
    assert.deepEqual(webCalls(upstreamFixed((id) => `${id}-streamed`, false)), [
      'webFetch',
      'webFetch',
      'webSearch',
      'webSearch',
    ])
  })
})
