// Replays real agent streams, captured from the contract suite (test/replay/<harness>/, refreshed
// with REEVAL_UPDATE_CAPTURES=1 on a real run), through today's code, key-free: reeval's normaliser must
// still find each behaviour's signals, each adapter (Antigravity, the Cursor SDK) must still translate the native events
// to the same tool calls, text and token counts, and every native event must match the committed
// format (test/replay/formats/). Claude Code's adapter translates inside its bridge, so its
// captured SDK messages (test/fixtures/claude-code-bridge/) replay through the bridge reeval ships.
// Each check has a twin that proves it can fail.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { HarnessV1StreamPart } from '@ai-sdk/harness'
import { AntigravityStreamTranslator } from '@reeval/harness-antigravity'
import { CodexStreamTranslator } from '@reeval/harness-codex'
import { CursorSdkStreamTranslator } from '@reeval/harness-cursor-sdk'
import { FxStreamTranslator } from '@reeval/harness-fx'
import { GooseStreamTranslator } from '@reeval/harness-goose'
import { OpenCodeStreamTranslator } from '@reeval/harness-opencode'
import { PiStreamTranslator } from '@reeval/harness-pi'
import { normaliseStream } from '../src/harness/transcript.ts'
import type { TranscriptEvent } from '../src/types.ts'
import { replayBridge } from './support/claude-code-bridge.ts'
import { testDir } from './support/fixture.ts'
import {
  knownSignatures,
  nativeEvents,
  nativeToolNames,
  signatures,
} from './support/stream-formats.ts'
import {
  type Catalog,
  catalogOfHarness,
  misfiled,
  unmappedNativeTools,
  unmappedTools,
} from './support/tool-catalog.ts'

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
const tools = (events: TranscriptEvent[]) => events.flatMap((e) => (e.type === 'tool' ? [e] : []))
const edits = (events: TranscriptEvent[]) =>
  events.flatMap((e) => (e.type === 'file-edit' ? [e] : []))

/** What each captured behaviour's stream must still say once normalised: robust signals only. */
const signals: Record<string, (events: TranscriptEvent[]) => void> = {
  skill(events) {
    // It read the file, or loaded it with its skill tool (OpenCode's `skill`, Goose's
    // `load_skill`).
    assert.ok(
      tools(events).some(
        (t) =>
          text(t.input).includes('contract-probe/SKILL.md') ||
          ((t.tool === 'skill' || t.tool === 'load_skill') &&
            text(t.input).includes('"contract-probe"')),
      ),
      'the agent read the skill',
    )
    assert.ok(edits(events).some((e) => e.path === 'skill-proof.txt'))
  },
  mcp(events) {
    const calls = tools(events).filter((t) => t.tool === 'mcp__stamp__house_stamp')
    assert.ok(calls.length)
    // The input is the MCP tool's own arguments, not Cursor's wrapper naming the server.
    for (const call of calls) assert.ok(!text(call.input).includes('providerIdentifier'))
  },
  'edit-and-run'(events) {
    assert.ok(edits(events).some((e) => e.path === 'notes.txt' && e.kind === 'modify'))
    assert.ok(tools(events).some((t) => text(t.output).includes('contract-42')))
  },
  egress(events) {
    assert.ok(tools(events).some((t) => text(t.input).includes('https://example.com/')))
  },
}

const harnesses = existsSync(root)
  ? readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'formats')
      .map((d) => d.name)
  : []

test('there are captures for Cursor, Antigravity, OpenCode, Goose, pi, Codex and fx', () => {
  assert.deepEqual(harnesses.sort(), [
    'antigravity',
    'codex',
    'cursor',
    'fx',
    'goose',
    'opencode',
    'pi',
  ])
})

test("skill.raw.jsonl's new file is a create where the harness says so, and a write otherwise", () => {
  const proof = (harness: string) =>
    edits(events(parse(read(harness, 'skill.raw.jsonl'))))
      .filter((e) => e.path.endsWith('skill-proof.txt'))
      .map((e) => [e.kind, e.added, e.removed])
  assert.deepEqual(Object.fromEntries(harnesses.map((h) => [h, proof(h)])), {
    antigravity: [['write', null, null]],
    codex: [['create', null, null]],
    cursor: [['create', 1, 0]],
    fx: [['write', 1, null]],
    goose: [['write', 1, null]],
    opencode: [['create', 1, 0]],
    pi: [['write', 1, null]],
  })
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
      test(`${name}: reeval's normaliser still finds its signals`, () => {
        const check = signals[name]
        assert.ok(check, `no signals for ${name}`)
        check(events(parse(read(harness, file))))
      })
    }
    test('twin: a capture checked for another behaviour fails', () => {
      assert.throws(() => signals.egress?.(events(parse(read(harness, 'skill.raw.jsonl')))))
    })
    test(`every tool call is in ${harness}'s catalog, its files and commands normalised`, async () => {
      const catalog = await catalogOfHarness(harness)
      for (const file of files) {
        const normalised = events(parse(read(harness, file)))
        assert.deepEqual(unmappedTools(catalog, normalised), [], file)
        assert.deepEqual(misfiled(catalog, behaviourOf(file), normalised), [], file)
      }
    })
    if (nativeToolNames(harness, []) !== null)
      test(`every tool ${harness}'s CLI called is one its adapter maps`, async () => {
        const catalog = await catalogOfHarness(harness)
        for (const file of files) {
          const names = nativeToolNames(harness, nativeEvents(read(harness, file))) ?? []
          assert.deepEqual(unmappedNativeTools(catalog, names), [], file)
        }
      })
  })
}

/** The eval a capture's file is named after: `edit-and-run.raw.jsonl` is `edit and run`. */
const behaviourOf = (file: string) => file.replace('.raw.jsonl', '').replaceAll('-', ' ')

// agy 1.4.3 renamed its file tools (view_file → read_file, write_to_file → write_file,
// replace_file_content → edit_file) with every event's shape unchanged. The adapter before it
// knew only the old names, so it passed the new ones on as dynamic tools under their own names:
// the captures (agy 1.4.3) as that adapter reported them must fail every check that guards the
// rename, naming the harness and the tool.
describe("replay: agy's file tools renamed under an adapter that knows only the old names", () => {
  const NATIVE = { read: 'read_file', write: 'write_file', edit: 'edit_file' } as const
  const RENAMED = Object.values(NATIVE) as string[]
  /** A capture's parts as the adapter before agy 1.4.3 reported its tool calls. */
  const beforeRename = (file: string) =>
    parse(read('antigravity', file)).map((l) => {
      const name = NATIVE[l.part.toolName as keyof typeof NATIVE]
      return (l.part.type === 'tool-call' || l.part.type === 'tool-result') && name
        ? { ...l, part: { ...l.part, toolName: name, dynamic: true } }
        : l
    })
  /** The catalog that adapter had: agy's new names map to nothing. */
  const oldCatalog = async (): Promise<Catalog> => {
    const catalog = await catalogOfHarness('antigravity')
    return {
      ...catalog,
      native: (n) => (RENAMED.includes(n) ? undefined : catalog.native(n)),
    }
  }

  test('the captures call the renamed tools', () => {
    const names = readdirSync(join(root, 'antigravity')).flatMap(
      (f) => nativeToolNames('antigravity', nativeEvents(read('antigravity', f))) ?? [],
    )
    for (const n of RENAMED) assert.ok(names.includes(n), n)
  })

  test("canary: the tool calls aren't in the catalog", async () => {
    const catalog = await catalogOfHarness('antigravity')
    assert.deepEqual(unmappedTools(catalog, events(beforeRename('edit-and-run.raw.jsonl'))), [
      'edit_file',
      'read_file',
    ])
    assert.deepEqual(unmappedTools(catalog, events(beforeRename('skill.raw.jsonl'))), [
      'read_file',
      'write_file',
    ])
  })

  test("canary: the CLI's tool names aren't ones the adapter maps", async () => {
    const catalog = await oldCatalog()
    const names = readdirSync(join(root, 'antigravity')).flatMap(
      (f) => nativeToolNames('antigravity', nativeEvents(read('antigravity', f))) ?? [],
    )
    assert.deepEqual(unmappedNativeTools(catalog, names), ['edit_file', 'read_file', 'write_file'])
  })

  test('canary: the edit and the skill read and write are not normalised', async () => {
    const catalog = await catalogOfHarness('antigravity')
    // Even with the new names in the catalog as tools of no kind, they aren't edits or reads.
    const passthrough: Catalog = {
      ...catalog,
      tools: new Map([...catalog.tools, ...RENAMED.map((n) => [n, undefined] as const)]),
    }
    for (const c of [catalog, passthrough]) {
      const edit = misfiled(c, 'edit and run', events(beforeRename('edit-and-run.raw.jsonl')))
      assert.equal(edit.length, 1, edit.join('\n'))
      assert.match(
        edit[0] ?? '',
        /^antigravity: the edit of notes\.txt isn't a file edit or a command: it arrived as read_file \(.+\), edit_file/,
      )
      const skill = misfiled(c, 'skill', events(beforeRename('skill.raw.jsonl')))
      assert.deepEqual(
        skill.map((s) => s.replace(/:.*/, '')),
        ['antigravity', 'antigravity'],
        skill.join('\n'),
      )
      assert.match(
        skill.join('\n'),
        /the read of the skill isn't a readonly or bash tool: it arrived as read_file/,
      )
      assert.match(
        skill.join('\n'),
        /the write of skill-proof\.txt isn't a file edit or a command: it arrived as write_file/,
      )
    }
  })

  test('canary: a command that arrives as an unknown tool is not a command', async () => {
    const catalog = await catalogOfHarness('antigravity')
    const lines = parse(read('antigravity', 'edit-and-run.raw.jsonl')).map((l) =>
      l.part.toolName === 'bash' ? { ...l, part: { ...l.part, toolName: 'run_cmd_v2' } } : l,
    )
    assert.deepEqual(unmappedTools(catalog, events(lines)), ['run_cmd_v2'])
    assert.match(
      misfiled(catalog, 'edit and run', events(lines)).join('\n'),
      /^antigravity: the command printing contract-42 isn't a bash tool: it arrived as run_cmd_v2 \(not in the catalog\)$/,
    )
  })
})

/** A native tool name in each harness's edit-and-run capture, and a name its adapter doesn't know. */
const renamedTool: Record<string, [string, string]> = {
  antigravity: ['"run_command"', '"run_cmd_v2"'],
  cursor: ['"name":"shell"', '"name":"shell_v2"'],
  pi: ['"name":"bash"', '"name":"bash_v2"'],
  codex: ['"type":"command_execution"', '"type":"shell_call"'],
}

type Count = number | undefined
/**
 * A finish part's tokens. Captured parts carry the AI SDK's numbers (`inputTokens` and its
 * `inputTokenDetails`); the translator's, `{ total, noCache, cacheRead, cacheWrite }`.
 */
const tokensOf = (usage: unknown) => {
  const u = (usage ?? {}) as Record<string, unknown>
  const input = u.inputTokens as Count | { total?: Count; [k: string]: Count }
  const output = u.outputTokens as Count | { total?: Count }
  const details = (u.inputTokenDetails ?? {}) as Record<string, Count>
  const split = typeof input === 'object' ? input : undefined
  return {
    input: typeof input === 'object' ? input.total : input,
    noCache: split ? split.noCache : details.noCacheTokens,
    cacheRead: split ? split.cacheRead : details.cacheReadTokens,
    cacheWrite: split ? split.cacheWrite : details.cacheWriteTokens,
    output: typeof output === 'object' ? output.total : output,
  }
}

/** Each harness's translator, fresh for one turn: the native events go back through it. */
const translators: Record<string, () => { push(line: string): HarnessV1StreamPart[] }> = {
  antigravity: () => new AntigravityStreamTranslator({ turn: 1 }),
  cursor: () => new CursorSdkStreamTranslator({ workDir: '/reeval/workspace' }),
  pi: () => new PiStreamTranslator(),
  codex: () => new CodexStreamTranslator({ workDir: '/reeval/workspace' }),
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
    /** What must match between the captured parts and today's: tool calls, text and tokens. */
    const essence = (parts: Array<{ type: string; [k: string]: unknown }>) => ({
      calls: parts
        .filter((p) => p.type === 'tool-call')
        .map((p) => [
          p.toolName,
          // The harness layer makes paths workspace-relative after the adapter.
          JSON.parse(text(p.input).replaceAll('/reeval/workspace/', '')),
        ]),
      text: parts
        .filter((p) => p.type === 'text-delta')
        .map((p) => p.delta ?? p.text)
        .join(''),
      tokens: tokensOf(parts.find((p) => p.type === 'finish')?.totalUsage),
    })

    test('twin: the same totals split another way between uncached input and cache reads', () => {
      const lines = parse(read(harness, 'edit-and-run.raw.jsonl'))
      const swapped = lines.map(({ part }) => {
        const u = part.type === 'finish' ? (part.totalUsage as Record<string, unknown>) : undefined
        const d = u?.inputTokenDetails as Record<string, number | undefined> | undefined
        if (!u || !d) return part
        const split = { noCacheTokens: d.cacheReadTokens, cacheReadTokens: d.noCacheTokens }
        return { ...part, totalUsage: { ...u, inputTokenDetails: { ...d, ...split } } }
      })
      const today = essence(retranslate(lines) as never).tokens
      assert.equal(essence(swapped).tokens.input, today.input)
      assert.notDeepEqual(essence(swapped).tokens, today)
    })

    for (const file of readdirSync(join(root, harness)).filter((f) => f.endsWith('.jsonl'))) {
      test(`${file}: the same tool calls, text and tokens as when it was captured`, () => {
        const lines = parse(read(harness, file))
        const captured = essence(lines.map((l) => l.part))
        assert.ok(
          captured.calls.length > 0 && captured.tokens.input,
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
// own step replays: the names it gives calls the bridge couldn't name, and the output text it
// takes from the ACP content.
describe('replay: the OpenCode adapter, from the captured parts', () => {
  type Part = { type: string; [k: string]: unknown }
  const record = (v: unknown) =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  /**
   * The captured parts as the bridge sends them: calls it couldn't name are `acp_tool_<id>`, and
   * a result is its `rawOutput` as `result` (no `output` text).
   */
  const fromBridge = (lines: Line[], named: Set<string>): Part[] =>
    lines.map((l) => {
      const part = l.part
      if (part.type !== 'tool-call' && part.type !== 'tool-result') return part
      const renamed = named.has(String(part.toolName))
        ? { ...part, toolName: `acp_tool_${part.toolCallId}` }
        : part
      if (renamed.type === 'tool-call') return { ...renamed, input: JSON.stringify(renamed.input) }
      const { output, ...rest } = renamed
      const { output: _text, ...raw } = record(output)
      return { ...rest, result: raw }
    })
  const replay = (lines: Line[], named: string[], mcpServers: string[] = []) => {
    const t = new OpenCodeStreamTranslator({ mcpServers })
    return fromBridge(lines, new Set(named)).flatMap((p) => t.push(p))
  }
  const names = (parts: Part[]) =>
    parts.filter((p) => p.type === 'tool-call').map((p) => p.toolName)
  const resultOf = (parts: Part[], name: string) =>
    record(parts.find((p) => p.type === 'tool-result' && p.toolName === name)?.result)

  for (const [file, named, mcp, output] of [
    ['edit-and-run.raw.jsonl', 'bash', [], /contract-42/],
    ['mcp.raw.jsonl', 'mcp__stamp__house_stamp', ['stamp'], /STAMP-7Q/],
  ] as const) {
    test(`${file}: ${named} is named again from OpenCode's first update, with its output`, () => {
      const lines = parse(read('opencode', file))
      const captured = names(lines.map((l) => l.part))
      assert.ok(captured.includes(named), `${named} is in the capture`)
      const out = replay(lines, [named], [...mcp])
      assert.deepEqual(names(out), captured)
      assert.match(String(resultOf(out, named).output), output)
    })
  }

  test('twin: without its first update, or the server, a call keeps the generic name', () => {
    const edit = parse(read('opencode', 'edit-and-run.raw.jsonl')).filter(
      (l) => !(l.part.type === 'raw' && record(l.part.rawValue).sessionUpdate === 'tool_call'),
    )
    const out = names(replay(edit, ['bash']))
    assert.ok(
      out.some((n) => String(n).startsWith('acp_tool_')),
      JSON.stringify(out),
    )
    const mcp = names(replay(parse(read('opencode', 'mcp.raw.jsonl')), ['mcp__stamp__house_stamp']))
    assert.ok(!mcp.includes('mcp__stamp__house_stamp'), JSON.stringify(mcp))
  })

  // OpenCode maps GPT models' `patch` tool to edit.
  const gptPatch = () =>
    parse(readFileSync(join(testDir, 'fixtures', 'opencode-gpt-patch.raw.jsonl'), 'utf8'))

  test("GPT's patch tool is an edit, and the files it changed are file edits", () => {
    const t = new OpenCodeStreamTranslator()
    const lines = gptPatch().map((l) => ({ ...l, part: t.push(l.part)[0] as Line['part'] }))
    assert.deepEqual(names(lines.map((l) => l.part)), ['edit'])
    assert.deepEqual(
      edits(events(lines)).map((e) => [e.path, e.kind, e.added]),
      [
        ['greet.js', 'create', 5],
        ['greet.test.js', 'create', 8],
      ],
    )
  })

  test('a patch call harness-acp names `patch` is an edit too (OpenCode 2.0.32)', () => {
    const named = parse(
      readFileSync(join(testDir, 'fixtures', 'opencode-gpt-patch-named.raw.jsonl'), 'utf8'),
    )
    const captured = names(named.map((l) => l.part))
    assert.ok(captured.includes('patch'), JSON.stringify(captured))
    const t = new OpenCodeStreamTranslator()
    const lines = named.map((l) => ({ ...l, part: t.push(l.part)[0] as Line['part'] }))
    const out = names(lines.map((l) => l.part))
    assert.ok(out.includes('edit') && !out.includes('patch'), JSON.stringify(out))
    assert.deepEqual(
      edits(events(lines)).map((e) => [e.path, e.kind, e.added, e.removed]),
      [['notes.txt', 'modify', 1, 1]],
    )
  })

  test('twin: without its first update, the patch call keeps the generic name', () => {
    const t = new OpenCodeStreamTranslator()
    const lines = gptPatch()
      .filter(
        (l) => !(l.part.type === 'raw' && record(l.part.rawValue).sessionUpdate === 'tool_call'),
      )
      .map((l) => ({ ...l, part: t.push(l.part)[0] as Line['part'] }))
    assert.ok(names(lines.map((l) => l.part)).every((n) => String(n).startsWith('acp_tool_')))
    assert.deepEqual(edits(events(lines)), [])
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

// fx's ACP events become parts inside @ai-sdk/harness-acp's bridge too: its adapter rebuilds a
// command's output from the `in_progress` updates (the `completed` one is a clipped summary) and
// names MCP calls from fx's `mcp_<server>_<tool>`.
describe('replay: the fx adapter, from the captured parts', () => {
  type Part = { type: string; [k: string]: unknown }
  const record = (v: unknown) =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  const clipped = [{ type: 'content', content: { type: 'text', text: '{"state":"completed"' } }]
  /** The captured parts as the bridge sends them: fx's own names, and a result's clipped content. */
  const fromBridge = (lines: Line[]): Part[] =>
    lines.map((l) => {
      const part = l.part
      if (part.type !== 'tool-call' && part.type !== 'tool-result') return part
      const named =
        part.toolName === 'mcp__stamp__house_stamp'
          ? { ...part, toolName: 'mcp_stamp_house_stamp' }
          : part
      if (named.type !== 'tool-result') return named
      const { output: _output, ...rest } = named
      return { ...rest, result: clipped }
    })
  const replay = (lines: Line[], mcpServers: string[] = []) => {
    const t = new FxStreamTranslator({ mcpServers })
    return fromBridge(lines).map((p) => t.push(p))
  }
  const bashResult = (parts: Part[]) =>
    record(parts.find((p) => p.type === 'tool-result' && p.toolName === 'bash')?.result)
  const names = (parts: Part[]) =>
    parts.filter((p) => p.type === 'tool-call').map((p) => p.toolName)
  const inProgress = (l: Line) =>
    l.part.type === 'raw' && record(l.part.rawValue).status === 'in_progress'

  test('edit-and-run.raw.jsonl: the command output is rebuilt from its in_progress updates', () => {
    const out = bashResult(replay(parse(read('fx', 'edit-and-run.raw.jsonl'))))
    assert.match(String(out.output), /contract-42/)
    assert.equal(out.exitCode, 0)
  })

  test('twin: without its in_progress updates, the output is not rebuilt', () => {
    const lines = parse(read('fx', 'edit-and-run.raw.jsonl')).filter((l) => !inProgress(l))
    assert.doesNotMatch(JSON.stringify(bashResult(replay(lines)).output ?? ''), /contract-42/)
  })

  test("mcp.raw.jsonl: the MCP call is named again from fx's mcp_<server>_<tool>", () => {
    const lines = parse(read('fx', 'mcp.raw.jsonl'))
    assert.ok(names(replay(lines, ['stamp'])).includes('mcp__stamp__house_stamp'))
  })

  test("twin: without the server, the MCP call keeps fx's name", () => {
    const lines = parse(read('fx', 'mcp.raw.jsonl'))
    assert.ok(!names(replay(lines)).includes('mcp__stamp__house_stamp'))
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
  codex: [
    ['"type":"turn.completed"', '"type":"turn.done"'],
    ['"type":"command_execution"', '"type":"shell_call"'],
    ['"aggregated_output"', '"output"'],
    ['"status":"completed"', '"status":"done"'],
    ['"kind":"update"', '"kind":"modify"'],
  ],
  goose: [
    ['"sessionUpdate":"tool_call"', '"sessionUpdate":"tool_use"'],
    ['"stopReason"', '"stop_reason"'],
    ['"status":"completed"', '"status":"done"'],
  ],
  fx: [
    ['"sessionUpdate":"tool_call"', '"sessionUpdate":"tool_use"'],
    ['"stopReason"', '"stop_reason"'],
    ['"status":"completed"', '"status":"done"'],
    ['"kind":"execute"', '"kind":"shell"'],
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

/**
 * Values ACP defines that a contract run shows only when the model does something: a tool call
 * that fails (a missing file, a bad edit), a turn cut short. Each is the same format, so a run
 * that happens to show one must pass.
 */
const acpOutcomes: Array<[RegExp, string]> = [
  [/"status":"completed"/g, '"status":"failed"'],
  [/"stopReason":"end_turn"/g, '"stopReason":"max_tokens"'],
  [/"stopReason":"end_turn"/g, '"stopReason":"max_turn_requests"'],
  [/"stopReason":"end_turn"/g, '"stopReason":"refusal"'],
  [/"stopReason":"end_turn"/g, '"stopReason":"cancelled"'],
]
/** Goose sends no `kind`; OpenCode and fx do (fx's `command_result` has its own). */
const acpKinds: Array<[RegExp, string]> = [
  [/"kind":"(read|edit|execute)"/g, '"kind":"fetch"'],
  [/"kind":"(read|edit|execute)"/g, '"kind":"switch_mode"'],
]

for (const [harness, outcomes] of [
  ['opencode', [...acpOutcomes, ...acpKinds]],
  ['goose', acpOutcomes],
  ['fx', [...acpOutcomes, ...acpKinds]],
] as const)
  describe(`replay: ${harness}'s format holds every value ACP defines`, () => {
    const known = new Set(knownSignatures(harness))
    for (const [from, to] of outcomes)
      test(`${to} is not a format change`, () => {
        const base = read(harness, 'edit-and-run.raw.jsonl')
        const changed = base.replaceAll(from, to)
        assert.notEqual(changed, base, `${from} is in the capture`)
        const unknown = signatures(harness, nativeEvents(changed)).filter((s) => !known.has(s))
        assert.deepEqual(unknown, [])
      })
  })

/** A harness package's own capture of its CLI's native NDJSON (its test/fixtures/). */
const packageCapture = (pkg: string, name: string) =>
  readFileSync(new URL(`../../${pkg}/test/fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

/** The signatures in `events` that the harness's format doesn't know. */
const unknownSignatures = (harness: string, events: Record<string, unknown>[]) => {
  const known = new Set(knownSignatures(harness))
  return signatures(harness, events).filter((s) => !known.has(s))
}

/** The edit-and-run capture with each replacement made; each must change it. */
function substituted(harness: string, ...replacements: Array<[RegExp | string, string]>) {
  const base = read(harness, 'edit-and-run.raw.jsonl')
  let changed = base
  for (const [from, to] of replacements) {
    const next = changed.replaceAll(from, to)
    assert.notEqual(next, changed, `${from} is in the capture`)
    changed = next
  }
  return nativeEvents(changed)
}

/** One raw-transcript line carrying `value` as the CLI's native event. */
const rawLine = (value: unknown) =>
  JSON.stringify({ turn: 0, ms: 1, part: { type: 'raw', rawValue: value } })

describe("replay: the Cursor runner's format holds every failure it can report", () => {
  // Real runner output (SDK 1.0.32): a rejected key, a turn reeval cancelled, and web calls the runner
  // recovered from the stored conversation.
  for (const file of ['bad-key.ndjson', 'cancelled.ndjson', 'web-recovered.ndjson'])
    test(`${file} is not a format change`, () => {
      assert.deepEqual(unknownSignatures('cursor', packageCapture('harness-cursor-sdk', file)), [])
    })

  for (const status of ['CREATING', 'ERROR', 'CANCELLED', 'EXPIRED'])
    test(`a status event's ${status} is not a format change`, () => {
      const events = substituted('cursor', ['"status":"FINISHED"', `"status":"${status}"`])
      assert.deepEqual(unknownSignatures('cursor', events), [])
    })

  test("a status event's message, a failed run's error and a truncated tool call are not", () => {
    const events = substituted(
      'cursor',
      ['"status":"FINISHED"', '"status":"ERROR","message":"the run failed"'],
      [
        '"status":"finished"',
        '"status":"error","error":{"message":"overloaded","code":"unavailable"}',
      ],
      ['"status":"completed"', '"status":"error","truncated":{"args":true,"result":true}'],
    )
    assert.deepEqual(unknownSignatures('cursor', events), [])
  })

  test("the runner's own failure lines: an error mid-turn and web calls it couldn't recover", () => {
    const capture = `${read('cursor', 'edit-and-run.raw.jsonl')}${[
      rawLine({ type: 'unreported', turn: 1, tools: ['webSearch'], message: 'store locked' }),
      rawLine({
        type: 'error',
        turn: 1,
        message: 'boom',
        name: 'ConnectError',
        code: 'unavailable',
        status: 503,
      }),
    ].join('\n')}\n`
    assert.deepEqual(unknownSignatures('cursor', nativeEvents(capture)), [])
  })

  test('twin: a status, run status or tool status the SDK does not define is a format change', () => {
    for (const [from, to] of [
      ['"status":"FINISHED"', '"status":"PAUSED"'],
      ['"status":"finished"', '"status":"expired"'],
      ['"status":"completed"', '"status":"failed"'],
    ] as const)
      assert.notDeepEqual(unknownSignatures('cursor', substituted('cursor', [from, to])), [], to)
  })
})

describe("replay: Antigravity's cached turn (agy 1.4.4)", () => {
  // One turn whose later steps read most of their prompt from Gemini's implicit cache. The
  // harness package's stream test holds its tokens to the Gemini API's own counts.
  const events = packageCapture('harness-antigravity', 'cached-steps.ndjson')

  test('its steps read from the cache, and it is not a format change', () => {
    const reads = events.flatMap((e) => {
      const usage = (e.step_update as { usage?: { cache_read_tokens?: number } } | undefined)?.usage
      return usage?.cache_read_tokens ? [usage.cache_read_tokens] : []
    })
    assert.ok(reads.length >= 5, `${reads.length} cached steps`)
    assert.deepEqual(unknownSignatures('antigravity', events), [])
  })
})

describe("replay: Antigravity's format holds every failure agy reports", () => {
  // agy 1.2.11 against a Gemini endpoint that refused each call (400, 429, 503), or dropped the
  // stream after the first chunk: one error_message step per try, then an ERROR result.
  for (const file of [
    'provider-400.ndjson',
    'provider-429.ndjson',
    'provider-503.ndjson',
    'provider-dropped-mid-stream.ndjson',
  ])
    test(`${file} is not a format change`, () => {
      const events = packageCapture('harness-antigravity', file)
      assert.ok(events.some((e) => JSON.stringify(e).includes('"step_type":"error_message"')))
      assert.deepEqual(unknownSignatures('antigravity', events), [])
    })

  for (const state of ['ERROR', 'CANCELED', 'CANCELLED'])
    test(`a tool step's ${state} is not a format change`, () => {
      const events = substituted('antigravity', [
        /"state":"DONE","step_type":"tool"/g,
        `"state":"${state}","step_type":"tool"`,
      ])
      assert.deepEqual(unknownSignatures('antigravity', events), [])
    })

  test("a failed tool's error and a failed turn's ERROR result are not", () => {
    const events = substituted(
      'antigravity',
      [
        /"state":"DONE","step_type":"tool",([^{]*)"tool_info":\{/g,
        '"state":"ERROR","step_type":"tool",$1"tool_info":{"error":{"type":"tool","message":"denied"},',
      ],
      ['"status":"SUCCESS"', '"status":"ERROR","error":"agent executor error: Error 503"'],
    )
    assert.deepEqual(unknownSignatures('antigravity', events), [])
  })

  test("twin: a state or step type agy's failures don't use is a format change", () => {
    const events = packageCapture('harness-antigravity', 'provider-503.ndjson')
    const renamed = JSON.parse(
      JSON.stringify(events).replaceAll(
        '"step_type":"error_message"',
        '"step_type":"error_notice"',
      ),
    ) as Record<string, unknown>[]
    assert.notDeepEqual(unknownSignatures('antigravity', renamed), [])
    const aborted = substituted('antigravity', [
      /"state":"DONE","step_type":"tool"/g,
      '"state":"ABORTED","step_type":"tool"',
    ])
    assert.notDeepEqual(unknownSignatures('antigravity', aborted), [])
    const onReply = substituted('antigravity', [
      /"state":"DONE","step_type":"agent_response"/g,
      '"state":"ERROR","step_type":"agent_response"',
    ])
    assert.notDeepEqual(unknownSignatures('antigravity', onReply), [])
  })
})

describe("replay: pi's format holds every stop reason pi defines, and a failed call's error", () => {
  const known = new Set(knownSignatures('pi'))
  const unknownIn = (events: Record<string, unknown>[]) =>
    signatures('pi', events).filter((s) => !known.has(s))

  // A nightly contract turn on pi 0.99 (edit and run) whose second model call Gemini refused (503).
  const unavailable = readFileSync(
    join(testDir, 'fixtures', 'pi-provider-unavailable.raw.jsonl'),
    'utf8',
  )

  test('a turn whose model call Gemini refused (503) is not a format change', () => {
    assert.match(unavailable, /"type":"message_start","message":\{[^\n]*"stopReason":"error"/)
    assert.deepEqual(unknownIn(nativeEvents(unavailable)), [])
  })

  test("twin: a key pi's failed call doesn't send is a format change", () => {
    const changed = unavailable.replaceAll('"thinkingLevel"', '"thinking_level"')
    assert.notDeepEqual(unknownIn(nativeEvents(changed)), [])
  })

  test('1.1.0 durationMs and agent_settled.aborted are not a format change', () => {
    const events = nativeEvents(read('pi', 'edit-and-run.raw.jsonl')).map((e) => {
      if (e.type === 'agent_settled') return { ...e, aborted: false }
      if (e.type === 'tool_execution_end') return { ...e, durationMs: 12 }
      const role = (e.message as { role?: string } | undefined)?.role
      const onMessage =
        (e.type === 'message_end' && (role === 'assistant' || role === 'toolResult')) ||
        (e.type === 'message_start' && role === 'toolResult') ||
        (e.type === 'turn_end' && role === 'assistant')
      if (!onMessage) return e
      const message = { ...(e.message as Record<string, unknown>), durationMs: 3 }
      const toolResults = e.toolResults as Array<Record<string, unknown>> | undefined
      return {
        ...e,
        message,
        ...(toolResults ? { toolResults: toolResults.map((r) => ({ ...r, durationMs: 4 })) } : {}),
      }
    })
    assert.deepEqual(unknownIn(events), [])
  })

  test("pi 0.87.1's whole failed turn (a bad key): message_start, message_end and turn_end", () => {
    assert.deepEqual(unknownIn(packageCapture('harness-pi', 'bad-key.ndjson')), [])
  })

  // Synthetic, not captured: the edit-and-run turn with a 503 on its second call, in pi 1.4.0's
  // auto-retry order (harness-pi's test/fixtures): recovered on the first retry, and failing every
  // retry.
  const normalised = (name: string) => {
    const t = new PiStreamTranslator()
    const lines = packageCapture('harness-pi', name).map((e) => JSON.stringify(e))
    // As the harness agent passes them on: a step's finish reason flat, a call's input parsed.
    const agentPart = (p: HarnessV1StreamPart) =>
      p.type === 'finish-step'
        ? { ...p, finishReason: p.finishReason.unified, rawFinishReason: p.finishReason.raw }
        : p.type === 'tool-call'
          ? { ...p, input: JSON.parse(p.input) }
          : p
    const parts = [...lines.flatMap((l) => t.push(l)), ...t.end({ exitCode: 0 })]
    return events(parts.map((p, ms) => ({ turn: 0, ms, part: agentPart(p) as Line['part'] })))
  }
  const kinds = (es: TranscriptEvent[]) => es.map((e) => e.type)

  test("a turn pi auto-retried is not a format change, and keeps the retry's work", () => {
    for (const name of ['auto-retry.ndjson', 'auto-retry-exhausted.ndjson'])
      assert.deepEqual(unknownIn(packageCapture('harness-pi', name)), [], name)
    const retried = normalised('auto-retry.ndjson')
    assert.ok(!kinds(retried).includes('error'), kinds(retried).join(' '))
    assert.equal(kinds(retried).filter((k) => k === 'retry').length, 1)
    const plain = normalised('edit-and-run.ndjson')
    assert.deepEqual(
      [...tools(retried), ...edits(retried)].map((e) => e.toolCallId),
      [...tools(plain), ...edits(plain)].map((e) => e.toolCallId),
    )
    assert.equal(edits(retried).length, 2)
  })

  test('twin: a call pi gave up retrying is an error, after a retry for each attempt', () => {
    const failed = kinds(normalised('auto-retry-exhausted.ndjson'))
    assert.equal(failed.filter((k) => k === 'retry').length, 3)
    assert.equal(failed.at(-1), 'error')
    const renamed = packageCapture('harness-pi', 'auto-retry.ndjson').map((e) =>
      e.type === 'auto_retry_start' ? { ...e, max_attempts: e.maxAttempts } : e,
    )
    assert.notDeepEqual(unknownIn(renamed), [])
  })

  // Synthetic, not captured: the auto-retry turn with its second call one pi 1.4.0 compacts for and
  // continues after (harness-pi's test/fixtures): it overflowed the context, or stopped at length.
  test("a turn pi continued after compacting is not a format change, and keeps the new run's work", () => {
    for (const name of ['compaction-overflow.ndjson', 'compaction-length.ndjson'])
      assert.deepEqual(unknownIn(packageCapture('harness-pi', name)), [], name)
    const plain = normalised('edit-and-run.ndjson')
    for (const name of ['compaction-overflow.ndjson', 'compaction-length.ndjson']) {
      const continued = normalised(name)
      assert.ok(!kinds(continued).includes('error'), `${name}: ${kinds(continued).join(' ')}`)
      assert.deepEqual(
        [...tools(continued), ...edits(continued)].map((e) => e.toolCallId),
        [...tools(plain), ...edits(plain)].map((e) => e.toolCallId),
        name,
      )
      assert.equal(edits(continued).length, 2, name)
    }
    assert.equal(
      kinds(normalised('compaction-overflow.ndjson')).filter((k) => k === 'retry').length,
      1,
    )
  })

  test("twin: a compaction that fails is an error, and its error message isn't a format change", () => {
    const events = packageCapture('harness-pi', 'compaction-overflow.ndjson')
    const end = events.findIndex((e) => e.type === 'compaction_end')
    const failed = [
      ...events.slice(0, end),
      {
        type: 'compaction_end',
        reason: 'overflow',
        aborted: false,
        willRetry: false,
        errorMessage: 'Context overflow recovery failed: summarization request failed',
      },
      { type: 'agent_settled', aborted: false },
    ]
    assert.deepEqual(unknownIn(failed), [])
    const t = new PiStreamTranslator()
    const parts = [...failed.flatMap((e) => t.push(JSON.stringify(e))), ...t.end({ exitCode: 0 })]
    const error = parts.find((p) => p.type === 'error') as { error?: Error } | undefined
    assert.match(String(error?.error?.message), /input token count.*recovery failed/s)
    const renamed = events.map((e) =>
      e.type === 'compaction_end' ? { ...e, will_retry: e.willRetry } : e,
    )
    assert.notDeepEqual(unknownIn(renamed), [])
  })

  for (const to of ['length', 'aborted', 'error'])
    test(`"stopReason":"${to}" is not a format change`, () => {
      const base = read('pi', 'edit-and-run.raw.jsonl')
      const changed = base.replaceAll('"stopReason":"stop"', `"stopReason":"${to}"`)
      assert.notEqual(changed, base)
      assert.deepEqual(unknownIn(nativeEvents(changed)), [])
    })

  test("twin: a stop reason pi's one-shot loop never ends a call with is a format change", () => {
    const base = read('pi', 'edit-and-run.raw.jsonl')
    const changed = base.replaceAll('"stopReason":"stop"', '"stopReason":"deferred"')
    assert.notDeepEqual(unknownIn(nativeEvents(changed)), [])
  })
})

describe("replay: OpenCode's format holds a model call it retried", () => {
  // A nightly contract turn (egress, gemini-3.8-flash) where Gemini refused the first call (503)
  // and OpenCode retried it: `session_info_update`s set `opencode/retry`, then clear it.
  const retried = readFileSync(
    join(testDir, 'fixtures', 'opencode-provider-retry.raw.jsonl'),
    'utf8',
  )

  test('the retry updates are not a format change, and the turn still ends', () => {
    assert.match(retried, /"opencode\/retry":\{"attempt":2/)
    assert.match(retried, /"opencode\/retry":null/)
    assert.deepEqual(unknownSignatures('opencode', nativeEvents(retried)), [])
    assert.ok(events(parse(retried)).some((e) => e.type === 'tool'))
  })

  test('twin: a key OpenCode sends outside _meta is a format change', () => {
    const changed = retried.replaceAll('"_meta":{"opencode/retry"', '"retry":{"opencode/retry"')
    assert.notEqual(changed, retried)
    assert.notDeepEqual(unknownSignatures('opencode', nativeEvents(changed)), [])
  })
})

describe("replay: fx's format holds a model call it retried", () => {
  // A contract turn on Vercel AI Gateway (skill, gemini-3.8-flash) where a model call timed out
  // (502) and fx retried it: `session_info_update`s report the recovery in `_meta.fx`.
  const retried = readFileSync(join(testDir, 'fixtures', 'fx-provider-retry.raw.jsonl'), 'utf8')
  const recovery = (l: Line) =>
    l.part.type === 'raw' && JSON.stringify(l.part.rawValue).includes('"modelResponseRecovery"')

  test('the recovery updates are not a format change, and change nothing in the transcript', () => {
    assert.match(retried, /"state":"active","kind":"auto_retry"/)
    assert.match(retried, /"state":"recovered"/)
    assert.deepEqual(unknownSignatures('fx', nativeEvents(retried)), [])
    const lines = parse(retried)
    const translate = (ls: Line[]) => {
      const t = new FxStreamTranslator()
      return ls.map((l) => ({ ...l, part: t.push(l.part as never) as Line['part'] }))
    }
    const all = events(translate(lines))
    assert.ok(all.some((e) => e.type === 'tool'))
    assert.deepEqual(all, events(translate(lines.filter((l) => !recovery(l)))))
  })

  test('twin: a key fx sends outside _meta is a format change', () => {
    const changed = retried.replaceAll('"_meta":{"fx"', '"recovery":{"fx"')
    assert.notEqual(changed, retried)
    assert.notDeepEqual(unknownSignatures('fx', nativeEvents(changed)), [])
  })
})

describe('replay: the Claude Code bridge, from the SDK’s own messages', () => {
  // A real contract turn (edit and run, claude-haiku-4-5): the host's `start` and every message
  // the bridge's query() loop saw. Claude Code acknowledges the bridge's streamed user message
  // with `command_lifecycle` messages before `system/init`, which names the model.
  const fixture = join(testDir, 'fixtures/claude-code-bridge/edit-and-run')
  const start = JSON.parse(readFileSync(`${fixture}.start.json`, 'utf8'))
  const messages = readFileSync(`${fixture}.sdk.jsonl`, 'utf8')
  const sdk = messages
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; subtype?: string; model?: string })
  // What the image bakes and the published package ships: the adapter's patched bridge.
  const shipped = join(testDir, '../dist/bridge/index.mjs')
  const fix = '!streamStarted && !beforeInit'

  test('the capture starts with command_lifecycle, then system/init names the model', () => {
    assert.equal(sdk[0]?.type, 'command_lifecycle')
    const init = sdk.findIndex((m) => m.type === 'system' && m.subtype === 'init')
    assert.ok(init > 0 && sdk.slice(0, init).every((m) => m.type === 'command_lifecycle'))
    assert.equal(sdk[init]?.model, 'claude-haiku-4-5')
  })

  test('the shipped bridge starts the stream with the served model, then the turn', async () => {
    const parts = await replayBridge({ bridge: shipped, start, messages })
    assert.deepEqual(parts[0], { type: 'stream-start', modelId: 'claude-haiku-4-5' })
    assert.equal(parts.filter((p) => p.type === 'stream-start').length, 1)
    const calls = parts.filter((p) => p.type === 'tool-call').map((p) => p.toolName)
    assert.deepEqual(calls, ['read', 'edit', 'bash'])
    assert.equal(parts.at(-1)?.type, 'finish')
  })

  test('a SessionStart hook reporting before system/init leaves the served model on the stream', async () => {
    // A plugin's SessionStart hook: Claude Code reports it in system hook_started and
    // hook_response messages, which can come before system/init.
    const init = sdk.findIndex((m) => m.type === 'system' && m.subtype === 'init')
    const hook = { type: 'system', hook_id: 'h1', hook_name: 'SessionStart:startup' }
    const hooked = [
      ...sdk.slice(0, init),
      { ...hook, subtype: 'hook_started' },
      { ...hook, subtype: 'hook_response', output: 'hook-ran', exit_code: 0 },
      ...sdk.slice(init),
    ]
    const replay = (bridge: string) =>
      replayBridge({ bridge, start, messages: hooked.map((m) => JSON.stringify(m)).join('\n') })
    assert.deepEqual((await replay(shipped))[0], {
      type: 'stream-start',
      modelId: 'claude-haiku-4-5',
    })
    // The twin: a bridge that skips only command_lifecycle starts the stream at the hook.
    const source = readFileSync(shipped, 'utf8')
    const hookClause =
      ' || type === "system" && typeof msg.subtype === "string" && msg.subtype.startsWith("hook_")'
    assert.ok(source.includes(hookClause), 'the shipped bridge skips hook messages')
    const dir = mkdtempSync(join(tmpdir(), 'reeval-hookless-'))
    const hookless = join(dir, 'bridge.mjs')
    writeFileSync(hookless, source.replace(hookClause, ''))
    try {
      assert.deepEqual((await replay(hookless))[0], { type: 'stream-start' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('twin: without the patch, command_lifecycle starts the stream and the model is lost', async () => {
    const source = readFileSync(shipped, 'utf8')
    assert.ok(source.includes(fix), 'the shipped bridge has the patch')
    const dir = mkdtempSync(join(tmpdir(), 'reeval-unpatched-'))
    const unpatched = join(dir, 'bridge.mjs')
    writeFileSync(unpatched, source.replace(fix, '!streamStarted'))
    try {
      const parts = await replayBridge({ bridge: unpatched, start, messages })
      assert.deepEqual(parts[0], { type: 'stream-start' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
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
    const t = new CursorSdkStreamTranslator({ workDir: '/reeval/workspace' })
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

describe("replay: Codex's format holds every item, status and failure codex exec defines", () => {
  // Real codex exec 0.157.1 output: a refused key (each retry an `error`, then `turn.failed`), a
  // command that exited non-zero (`failed`), a turn with reasoning summaries that added and
  // deleted a file, and a page the model opened with its web tool.
  for (const file of [
    'bad-key.ndjson',
    'failed-command.ndjson',
    'plan-and-reasoning.ndjson',
    'web.ndjson',
  ])
    test(`${file} is not a format change`, () => {
      assert.deepEqual(unknownSignatures('codex', packageCapture('harness-codex', file)), [])
    })

  for (const status of ['in_progress', 'failed', 'declined'])
    test(`a command's ${status} is not a format change`, () => {
      const events = substituted('codex', [
        /"type":"command_execution",([^}]*)"status":"completed"/g,
        `"type":"command_execution",$1"status":"${status}"`,
      ])
      assert.deepEqual(unknownSignatures('codex', events), [])
    })

  test('a failed patch, a failed MCP call and every item type Codex defines are not', () => {
    const item = (type: string, fields: Record<string, unknown>) =>
      rawLine({ type: 'item.completed', item: { id: 'i', type, ...fields } })
    const capture = `${read('codex', 'edit-and-run.raw.jsonl')}${[
      item('file_change', { changes: [{ path: '/x', kind: 'delete' }], status: 'failed' }),
      item('mcp_tool_call', {
        server: 's',
        tool: 't',
        arguments: {},
        result: null,
        error: { message: 'no such tool' },
        status: 'failed',
      }),
      item('reasoning', { text: 'thinking' }),
      item('todo_list', { items: [{ text: 'a', completed: false }] }),
      item('web_search', { query: 'q', action: { type: 'search', query: 'q' } }),
      item('collab_tool_call', {
        tool: 'spawn_agent',
        sender_thread_id: 'a',
        receiver_thread_ids: ['b'],
        prompt: 'p',
        agents_states: { b: { status: 'running', message: null } },
        status: 'in_progress',
      }),
      item('error', { message: 'Falling back from WebSockets to HTTPS transport.' }),
      rawLine({ type: 'error', message: 'Reconnecting... 1/5' }),
      rawLine({ type: 'turn.failed', error: { message: 'unexpected status 401' } }),
    ].join('\n')}\n`
    assert.deepEqual(unknownSignatures('codex', nativeEvents(capture)), [])
  })

  test("twin: an item type, status or key codex exec doesn't define is a format change", () => {
    const item = (fields: Record<string, unknown>) =>
      nativeEvents(rawLine({ type: 'item.completed', item: { id: 'i', ...fields } }))
    assert.notDeepEqual(unknownSignatures('codex', item({ type: 'image_view', path: '/x' })), [])
    assert.notDeepEqual(
      unknownSignatures(
        'codex',
        item({
          type: 'command_execution',
          command: 'x',
          aggregated_output: '',
          exit_code: 0,
          status: 'timed_out',
        }),
      ),
      [],
    )
    assert.notDeepEqual(
      unknownSignatures('codex', item({ type: 'agent_message', text: 'x', phase: 'final' })),
      [],
    )
  })
})
