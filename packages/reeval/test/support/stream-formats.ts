// The shape of each agent CLI's native stream, as signatures: which events and step types it
// sends, the key paths in each, the states it reports and the tools it advertises. Taken from the
// `raw` parts of a raw transcript (REEVAL_RAW_TRANSCRIPT=1), which carry the native events. The known
// signatures are committed in test/replay/formats/<harness>.json; a signature outside them means
// the CLI's output format changed, and the contract fails on it (the drift job's loud failure).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { testDir } from './fixture.ts'

type Format = {
  /** What kind of event this is, e.g. `step_update/tool`. */
  kind: (event: Record<string, unknown>) => string | undefined
  /** Subtrees whose keys vary with the tool or the model (tool inputs and outputs): keys not kept. */
  opaque: string[]
  /** Keys whose values are part of the format (states, statuses). */
  values: string[]
  /** Lists whose string members are part of the format (the tools the CLI advertises). */
  lists: string[]
  /**
   * Every value the CLI's protocol defines for a value key, by signature (`<kind> .<key>`): all are
   * the format, not only those a run happened to show. Which one a run shows (a failed tool call, a
   * refusal) is the model's doing, so learning them from runs made the check depend on the model.
   */
  defined?: Record<string, readonly string[]>
  /**
   * Keys and events the CLI's protocol defines for one outcome only, by signature (`<kind> .<key>`),
   * for the same reason: a provider's refusal (pi's `errorMessage`, agy's `error_message` steps) or
   * a cancelled turn shows them, whatever the CLI's version.
   */
  optional?: readonly string[]
}

// ACP's ToolCallStatus, ToolKind and StopReason: every value @ai-sdk/harness-acp's bridge handles.
const ACP_STATUS = ['pending', 'in_progress', 'completed', 'failed']
const ACP_KIND = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]
const ACP_DEFINED = {
  'tool_call .status': ACP_STATUS,
  'tool_call_update .status': ACP_STATUS,
  'tool_call .kind': ACP_KIND,
  'tool_call_update .kind': ACP_KIND,
  'prompt-response .stopReason': [
    'end_turn',
    'max_tokens',
    'max_turn_requests',
    'refusal',
    'cancelled',
  ],
}

// pi's assistant messages: pi-ai's StopReason, but `deferred` (pi's one-shot `-p` loop never defers
// a call) and `pending` (only while a message streams), and a failed call's `errorMessage`. A
// contract run shows `error` only when the provider fails a call (a 503), `length` and `aborted`
// only when the model runs out of tokens or reeval stops the turn.
const PI_MESSAGES = ['message_start/assistant', 'message_end/assistant', 'turn_end/assistant']
const PI_STOP = ['stop', 'toolUse', 'length', 'aborted', 'error']
const PI_DEFINED = Object.fromEntries(
  PI_MESSAGES.map((kind) => [
    `${kind} .message.stopReason`,
    kind === 'message_start/assistant' ? ['pending', ...PI_STOP] : PI_STOP,
  ]),
)
const PI_OPTIONAL = PI_MESSAGES.map((kind) => `${kind} .message.errorMessage`)

// The Cursor runner's lines, as CursorSdkRunnerLine types them, and the SDK's (1.0.32) own values:
// SDKStatusMessage's status and message, SDKToolUseMessage's status and truncated, RunResult's
// status and error. A run reeval cancels streams CANCELLED; a failed one ERROR with the error; a turn
// that throws (a rejected key) is the runner's `error` line; `unreported` and `recovered` come only
// with web calls.
const CURSOR_DEFINED = {
  'event/status .event.status': [
    'CREATING',
    'RUNNING',
    'FINISHED',
    'ERROR',
    'CANCELLED',
    'EXPIRED',
  ],
  'event/tool_call .event.status': ['running', 'completed', 'error'],
  'result .status': ['finished', 'error', 'cancelled'],
}
const CURSOR_OPTIONAL = [
  'event/status .event.message',
  'event/tool_call .event.truncated',
  'event/tool_call .event.truncated.args',
  'event/tool_call .event.truncated.result',
  'event/tool_call .recovered',
  'event/tool_call .event.started_at_ms',
  'event/tool_call .event.completed_at_ms',
  'result .error',
  'result .error.message',
  'result .error.code',
  ...['type', 'turn', 'message', 'name', 'code', 'status'].map((k) => `error .${k}`),
  ...['type', 'turn', 'tools', 'message'].map((k) => `unreported .${k}`),
]

// agy's (1.2.11) states for a tool step, the ones the adapter ends a call on, and its result
// statuses. A call the provider refuses (4xx, 429, 5xx) or drops mid-stream is an `error_message`
// step per try, then an ERROR result with its error; a failed tool is ERROR or CANCELED (or
// CANCELLED) with `tool_info.error`.
const AGY_ERROR_STEP = 'step_update/error_message'
const ANTIGRAVITY_DEFINED = {
  'step_update/tool .step_update.state': ['ACTIVE', 'DONE', 'ERROR', 'CANCELED', 'CANCELLED'],
  [`${AGY_ERROR_STEP} .step_update.state`]: ['DONE'],
  'result .result.status': ['SUCCESS', 'ERROR'],
}
const ANTIGRAVITY_OPTIONAL = [
  ...['', '.conversation_id', '.step_index', '.state', '.step_type', '.duration_seconds'].map(
    (k) => `${AGY_ERROR_STEP} .step_update${k}`,
  ),
  `${AGY_ERROR_STEP} .event`,
  'result .result.error',
  'step_update/tool .step_update.tool_info.error',
  'step_update/tool .step_update.tool_info.error.message',
  'step_update/tool .step_update.tool_info.error.type',
]

// codex exec's (0.157.1) `--json` JSONL, as codex-rs/exec/src/exec_events.rs types it: every
// event, item type, key and status it defines is the format, whichever a run shows. A command the
// model ran that exited non-zero is `failed`; a turn that ends on a refused key is `error` events
// (Codex retrying) and `turn.failed`; reasoning, to-do list, web search and sub-agent items come
// with the model, the prompt and the features on.
const CODEX_ITEM_KEYS: Record<string, readonly string[]> = {
  agent_message: ['text'],
  reasoning: ['text'],
  command_execution: ['command', 'aggregated_output', 'exit_code', 'status'],
  file_change: ['changes', 'changes[].path', 'changes[].kind', 'status'],
  mcp_tool_call: ['server', 'tool', 'arguments', 'result', 'error', 'error.message', 'status'],
  collab_tool_call: [
    'tool',
    'sender_thread_id',
    'receiver_thread_ids',
    'prompt',
    'agents_states',
    'status',
  ],
  web_search: ['query', 'action', 'results'],
  todo_list: ['items'],
  error: ['message'],
}
const CODEX_STATUS: Record<string, readonly string[]> = {
  command_execution: ['in_progress', 'completed', 'failed', 'declined'],
  file_change: ['in_progress', 'completed', 'failed'],
  mcp_tool_call: ['in_progress', 'completed', 'failed'],
  collab_tool_call: ['in_progress', 'completed', 'failed'],
}
const CODEX_ITEM_KINDS = ['item.started', 'item.updated', 'item.completed'].flatMap((event) =>
  Object.keys(CODEX_ITEM_KEYS).map((item) => [`${event}/${item}`, item] as const),
)
const CODEX_DEFINED = Object.fromEntries(
  CODEX_ITEM_KINDS.flatMap(([kind, item]) => [
    ...(CODEX_STATUS[item] ? [[`${kind} .item.status`, CODEX_STATUS[item]]] : []),
    ...(item === 'file_change'
      ? [[`${kind} .item.changes[].kind`, ['add', 'delete', 'update']]]
      : []),
  ]),
)
const CODEX_OPTIONAL = [
  ...['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error'].map(
    (kind) => `${kind} .type`,
  ),
  'thread.started .thread_id',
  ...[
    '',
    '.input_tokens',
    '.cached_input_tokens',
    '.cache_write_input_tokens',
    '.output_tokens',
    '.reasoning_output_tokens',
  ].map((k) => `turn.completed .usage${k}`),
  'turn.failed .error',
  'turn.failed .error.message',
  'error .message',
  ...CODEX_ITEM_KINDS.flatMap(([kind, item]) =>
    ['', 'id', 'type', ...(CODEX_ITEM_KEYS[item] ?? [])]
      .map((k) => `${kind} .item${k ? `.${k}` : ''}`)
      .concat(`${kind} .type`),
  ),
]

const FORMATS: Record<string, Format> = {
  antigravity: {
    kind: (e) => {
      if (typeof e.event !== 'string') return undefined
      const step = (e.step_update as { step_type?: unknown } | undefined)?.step_type
      return typeof step === 'string' ? `${e.event}/${step}` : e.event
    },
    opaque: ['parameters', 'output', 'structured_output'],
    values: ['state', 'status', 'permission_mode'],
    lists: ['tools'],
    defined: ANTIGRAVITY_DEFINED,
    optional: ANTIGRAVITY_OPTIONAL,
  },
  // The Cursor SDK harness's runner lines: `init`, `event` (the SDK's own messages), `result`.
  cursor: {
    kind: (e) => {
      if (typeof e.type !== 'string') return undefined
      const inner = (e.event as { type?: unknown } | undefined)?.type
      return typeof inner === 'string' ? `${e.type}/${inner}` : e.type
    },
    opaque: ['args', 'value', 'params', 'result'],
    values: ['status', 'role'],
    lists: [],
    defined: CURSOR_DEFINED,
    optional: CURSOR_OPTIONAL,
  },
  // OpenCode's ACP `session/update`s, by `sessionUpdate`, and its `session/prompt` response.
  opencode: {
    kind: (e) =>
      typeof e.sessionUpdate === 'string'
        ? e.sessionUpdate
        : typeof e.stopReason === 'string'
          ? 'prompt-response'
          : undefined,
    opaque: [
      'rawInput',
      'rawOutput',
      'content',
      'locations',
      'availableCommands',
      'configOptions',
      '_meta',
    ],
    values: ['status', 'kind', 'stopReason'],
    lists: [],
    defined: ACP_DEFINED,
  }, // Goose's ACP `session/update`s, by `sessionUpdate`, and its `session/prompt` response.
  goose: {
    kind: (e) =>
      typeof e.sessionUpdate === 'string'
        ? e.sessionUpdate
        : typeof e.stopReason === 'string'
          ? 'prompt-response'
          : undefined,
    opaque: [
      'rawInput',
      'rawOutput',
      'content',
      'locations',
      'availableCommands',
      'configOptions',
      '_meta',
    ],
    values: ['status', 'kind', 'stopReason'],
    lists: [],
    defined: ACP_DEFINED,
  },
  // pi's `--mode json` events, by `type` (and the assistant event inside `message_update`).
  pi: {
    kind: (e) => {
      if (typeof e.type !== 'string') return undefined
      const inner = (e.assistantMessageEvent as { type?: unknown } | undefined)?.type
      const role = (e.message as { role?: unknown } | undefined)?.role
      return typeof inner === 'string'
        ? `${e.type}/${inner}`
        : typeof role === 'string'
          ? `${e.type}/${role}`
          : e.type
    },
    opaque: [
      'arguments',
      'args',
      'content',
      'result',
      'partialResult',
      'sections',
      'messages',
      'errorMessage',
      'details',
      'thoughtSignature',
      'delta',
      'toolCall',
    ],
    values: ['stopReason', 'role', 'api', 'provider'],
    lists: [],
    defined: PI_DEFINED,
    optional: PI_OPTIONAL,
  },
  // codex exec's `--json` events, by `type` (and an item event's `item.type`).
  codex: {
    kind: (e) => {
      if (typeof e.type !== 'string') return undefined
      const item = (e.item as { type?: unknown } | undefined)?.type
      return typeof item === 'string' ? `${e.type}/${item}` : e.type
    },
    opaque: [
      'arguments',
      'result',
      'text',
      'aggregated_output',
      'command',
      'message',
      'query',
      'items',
      'action',
      'results',
      'agents_states',
      'prompt',
    ],
    values: ['status', 'kind'],
    lists: [],
    defined: CODEX_DEFINED,
    optional: CODEX_OPTIONAL,
  },
}

export const hasFormat = (harness: string) => Object.hasOwn(FORMATS, harness)

/** The native events in a raw transcript: the `raw` parts' values that the CLI sent as JSON. */
export function nativeEvents(rawTranscript: string): Record<string, unknown>[] {
  return rawTranscript
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const part = (JSON.parse(line) as { part?: { type?: string; rawValue?: unknown } }).part
      const value = part?.type === 'raw' ? part.rawValue : undefined
      return value && typeof value === 'object' && !('unparsed' in value)
        ? [value as Record<string, unknown>]
        : []
    })
}

/** Every signature in the events, sorted. */
export function signatures(harness: string, events: Record<string, unknown>[]): string[] {
  const f = FORMATS[harness]
  if (!f) return []
  const out = new Set<string>()
  const walk = (value: unknown, kind: string, path: string) => {
    if (Array.isArray(value)) {
      for (const v of value) walk(v, kind, `${path}[]`)
      return
    }
    if (!value || typeof value !== 'object') return
    for (const [key, v] of Object.entries(value)) {
      const at = `${path}.${key}`
      out.add(`${kind} ${at}`)
      if (f.opaque.includes(key)) continue
      if (f.values.includes(key) && typeof v === 'string') out.add(`${kind} ${at}=${v}`)
      if (f.lists.includes(key) && Array.isArray(v)) {
        for (const item of v) if (typeof item === 'string') out.add(`${kind} ${at}[]=${item}`)
        continue
      }
      walk(v, kind, at)
    }
  }
  for (const e of events) {
    const kind = f.kind(e)
    if (!kind) {
      out.add(`unknown event ${JSON.stringify(Object.keys(e).sort())}`)
      continue
    }
    walk(e, kind, '')
  }
  return [...out].sort()
}

const formatsFile = (harness: string) => join(testDir, 'replay', 'formats', `${harness}.json`)

/** The signatures of every value and outcome-only key the harness's protocol defines. */
const definedSignatures = (harness: string): Set<string> =>
  new Set([
    ...Object.entries(FORMATS[harness]?.defined ?? {}).flatMap(([at, values]) =>
      values.map((v) => `${at}=${v}`),
    ),
    ...(FORMATS[harness]?.optional ?? []),
  ])

const committedSignatures = (harness: string): string[] =>
  existsSync(formatsFile(harness))
    ? (JSON.parse(readFileSync(formatsFile(harness), 'utf8')) as string[])
    : []

export const knownSignatures = (harness: string): string[] =>
  [...new Set([...committedSignatures(harness), ...definedSignatures(harness)])].sort()

/** Adds `seen` to the known signatures (REEVAL_UPDATE_FORMATS=1); the protocol's values aren't kept. */
export function learnSignatures(harness: string, seen: string[]): void {
  const defined = definedSignatures(harness)
  const all = [...new Set([...committedSignatures(harness), ...seen])]
    .filter((s) => !defined.has(s))
    .sort()
  writeFileSync(formatsFile(harness), `${JSON.stringify(all, null, 2)}\n`)
}

/** Every `transcript.raw.jsonl` under `dir`. */
export function rawTranscripts(dir: string): string[] {
  const found: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name))
      else if (e.name === 'transcript.raw.jsonl') found.push(join(d, e.name))
    }
  }
  walk(dir)
  return found
}
