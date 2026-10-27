// Each harness's tool catalog (its adapter's `builtinTools`) as the contract and the replays check
// it: every tool a CLI calls must be one its adapter knows, and a contract behavior's file edit,
// file read or command must land on a tool of that kind. A tool outside the catalog reaches the
// transcript under its native name, so a renamed tool (agy 1.4.3's `view_file` → `read_file`)
// would otherwise drop the edit out of the transcript while every other check still passes.
import { projectToolCall as antigravityTool } from '@reeval/harness-antigravity'
import { projectToolCall as cursorTool } from '@reeval/harness-cursor-sdk'
import type { AgentKind } from '../../src/harness/agents.ts'
import { agentFor } from '../../src/harness/agents.ts'
import type { TranscriptEvent } from '../../src/types.ts'
import { type HarnessRow, harnesses, harnessOf } from './harnesses.ts'

export type ToolKind = 'readonly' | 'edit' | 'bash'

export type Catalog = {
  harness: string
  /** Each tool's name in the transcript, and its kind (`toolUseKind`), when it has one. */
  tools: ReadonlyMap<string, ToolKind | undefined>
  /** The catalog name a native tool name lands on, or undefined when the adapter doesn't map it. */
  native: (name: string) => string | undefined
}

/** The fake agent's own tools: it runs commands as `shell` and writes files as file edits. */
const FAKE_TOOLS = new Map<string, ToolKind | undefined>([['shell', 'bash']])

/** Native names some adapters map outside their catalog's `nativeName`s, through their own projection. */
const PROJECTIONS: Partial<
  Record<string, (name: string) => { toolName: string; dynamic: boolean }>
> = {
  antigravity: (name) => antigravityTool(name),
  cursor: (name) => cursorTool(name, {}),
}

const isMcp = (name: string) => name.startsWith('mcp__')

/** The row's catalog, from the adapter reeval builds for its harness and model. */
export async function catalogOf(row: HarnessRow): Promise<Catalog> {
  const harness = harnessOf(row)
  if (harness === 'fake')
    return { harness, tools: FAKE_TOOLS, native: (n) => (FAKE_TOOLS.has(n) ? n : undefined) }
  const kind = harness as AgentKind
  const agent = agentFor({ kind, model: row.model ?? '' } as never)
  const adapter = await agent.adapter({
    auth: { [agent.credential]: 'probe' },
    descriptor: { kind, model: row.model ?? '' },
    model: row.model ?? '',
    plugins: [],
  } as never)
  const builtins = (adapter.builtinTools ?? {}) as Record<
    string,
    { nativeName?: string; toolUseKind?: ToolKind }
  >
  const tools = new Map(Object.entries(builtins).map(([key, t]) => [key, t.toolUseKind]))
  const byNative = new Map(Object.entries(builtins).map(([key, t]) => [t.nativeName ?? key, key]))
  const project = PROJECTIONS[harness]
  const native = (name: string) => {
    if (isMcp(name)) return name
    if (project) {
      const p = project(name)
      return p.dynamic ? undefined : p.toolName
    }
    return byNative.get(name) ?? (tools.has(name) ? name : undefined)
  }
  return { harness, tools, native }
}

/** The catalog of the first row that runs `harness`, for the captured streams (one per CLI). */
export const catalogOfHarness = (harness: string) => {
  const row = harnesses.find((r) => harnessOf(r) === harness)
  if (!row) throw new Error(`no contract row runs ${harness}`)
  return catalogOf(row)
}

/** The tool calls in `events` whose name the catalog doesn't know, each once. MCP tools are known. */
export function unmappedTools(catalog: Catalog, events: readonly TranscriptEvent[]): string[] {
  const names = events.flatMap((e) => (e.type === 'tool' ? [e.tool] : []))
  return [...new Set(names.filter((n) => !isMcp(n) && !catalog.tools.has(n)))].sort()
}

/** The native tool names the adapter doesn't map to its catalog, each once. */
export function unmappedNativeTools(catalog: Catalog, names: readonly string[]): string[] {
  return [...new Set(names.filter((n) => catalog.native(n) === undefined))].sort()
}

const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''))

/**
 * A file or command signal of one contract behavior, and the kinds it must land on: an edit is a
 * file-edit event (or a command naming the file, when the agent edits from the shell), a read a
 * readonly tool or a command, a command a command.
 */
type Signal = { what: string } & (
  | { edit: string }
  | { mentions: string; kinds: readonly ToolKind[] }
  | { output: string; kinds: readonly ToolKind[] }
)

/** Each captured behavior's file and command signals, by eval name. */
export const SIGNALS: Record<string, readonly Signal[]> = {
  'edit and run': [
    { what: 'the edit of notes.txt', edit: 'notes.txt' },
    { what: 'the command printing contract-42', output: 'contract-42', kinds: ['bash'] },
  ],
  skill: [
    { what: 'the read of the skill', mentions: 'contract-probe', kinds: ['readonly', 'bash'] },
    { what: 'the write of skill-proof.txt', edit: 'skill-proof.txt' },
  ],
  egress: [{ what: 'the curl to example.com', mentions: 'https://example.com/', kinds: ['bash'] }],
}

/**
 * The signals of `behavior` that didn't land on their kind, each as a sentence naming the
 * harness and the tools that carried it instead; empty when every signal did.
 */
export function misfiled(
  catalog: Catalog,
  behavior: string,
  events: readonly TranscriptEvent[],
): string[] {
  const tools = events.flatMap((e) => (e.type === 'tool' ? [e] : []))
  const kindOf = (name: string) => catalog.tools.get(name)
  const describe = (t: { tool: string }) =>
    `${t.tool} (${catalog.tools.has(t.tool) ? (kindOf(t.tool) ?? 'no kind') : 'not in the catalog'})`
  const failures: string[] = []
  for (const s of SIGNALS[behavior] ?? []) {
    let carriers: typeof tools
    let landed: boolean
    if ('edit' in s) {
      carriers = tools.filter((t) => text(t.input).includes(s.edit))
      landed =
        events.some((e) => e.type === 'file-edit' && e.path === s.edit) ||
        carriers.some((t) => kindOf(t.tool) === 'bash')
    } else {
      const needle = 'mentions' in s ? s.mentions : s.output
      carriers = tools.filter((t) =>
        'mentions' in s
          ? text(t.input).includes(needle) || text(t.output).includes(needle)
          : text(t.output).includes(needle),
      )
      landed = carriers.some((t) => s.kinds.includes(kindOf(t.tool) as ToolKind))
    }
    if (landed) continue
    const by = carriers.length
      ? `it arrived as ${carriers.map(describe).join(', ')}`
      : 'no tool carried it'
    const want = 'edit' in s ? 'a file edit or a command' : `a ${s.kinds.join(' or ')} tool`
    failures.push(`${catalog.harness}: ${s.what} isn't ${want}: ${by}`)
  }
  return failures
}
