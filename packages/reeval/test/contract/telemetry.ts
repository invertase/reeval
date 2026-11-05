// What each harness's record captures of the telemetry its CLI and provider produce, signal by
// signal, against ground truth (the gateway's decrypted wire, the native stream and the sandbox's
// files). Internal engineering detail: it stays out of the catalog, which ships, and out of the
// public docs. `test/contract-telemetry.test.ts` holds every harness to a declaration for every
// signal and renders the table in README.md. The states are what a parity check against the wire
// holds a row to: a `captured` or `partial` signal must be in the record, and a `dropped` one must
// not, so a gap that closes fails until its cell says so.
import type { AgentKind } from '../../src/harness/agents.ts'

/**
 * - `captured`: in the record and equal to ground truth.
 * - `partial`: in the record but incomplete or reshaped (the note says how).
 * - `dropped`: produced (on the wire, in the stream or on disk) but not in the record.
 * - `not-produced`: the CLI or provider doesn't produce it in the contract's configuration.
 */
export type TelemetryState = 'captured' | 'partial' | 'dropped' | 'not-produced'

export type TelemetryDeclaration = {
  state: TelemetryState
  /** How a `partial` signal differs, or where a `dropped` one is; required for `partial`. */
  note?: string
  /**
   * Set when ground truth couldn't be read (Cursor's protobuf wire, a path no run reached): the
   * state is the best reading of the record alone, and a parity check can't hold it to the wire.
   */
  unverified?: true
}

/** The signals, in the table's order, each with what a parity check compares in the record. */
export const SIGNALS = {
  turnTokens: {
    label: 'Main-call tokens per turn',
    record: "turn `usage` input and output: the sum of the turn's main model calls",
  },
  cacheRead: {
    label: 'Fresh input vs cache read',
    record: 'turn `usage.input` uncached, `usage.cacheRead` apart',
  },
  cacheWrite: { label: 'Cache write', record: 'turn `usage.cacheWrite`' },
  reasoningTokens: { label: 'Reasoning tokens', record: 'turn `usage.reasoning`' },
  reasoningText: {
    label: 'Reasoning text',
    record: 'non-empty `reasoning` events when the wire carries reasoning text',
  },
  perCallUsage: { label: 'Per-call usage', record: "each model call's usage, not only the turn's" },
  sideCallUsage: {
    label: 'Side-call usage (titles, search)',
    record:
      "usage of calls outside the agent loop (titles, web search), apart from the main calls'",
  },
  servedModel: {
    label: 'Served model (gateway)',
    record: "the attempt's `servedModels`, from the model calls' responses",
  },
  cost: {
    label: 'Provider or CLI cost',
    record: "the cost the provider or the CLI reports, never reeval's own price table",
  },
  abortedUsage: {
    label: 'Usage on an aborted turn',
    record: "a timed-out turn's `usage`, equal to the calls the wire shows",
  },
  abortedTranscript: {
    label: 'Transcript of an aborted turn',
    record: "a timed-out turn's events: the tool calls whose requests the wire shows",
  },
  largeShellOutput: {
    label: 'Large shell output',
    record: "a ~300 KB command's output in its tool event: full, or marked truncated or spilled",
  },
  largeMcpResult: {
    label: 'Large MCP result',
    record: 'a ~60 KB MCP result in its tool event: full, or marked truncated or spilled',
  },
  mcpCall: {
    label: 'Small MCP args and result',
    record: "an MCP call's arguments and result text, without the CLI's own wrapper",
  },
  contextWindow: {
    label: 'Context window used and size',
    record: 'the context occupancy and window size the CLI reports',
  },
  systemPrompt: {
    label: 'System prompt and tool count',
    record: "each model call's system prompt size and tool count",
  },
  rateLimits: {
    label: 'Retries, 429s, rate-limit headers',
    record: "retried calls, 429s and the provider's rate-limit headers",
  },
  compaction: { label: 'Compaction', record: 'a compaction event when the CLI compacts context' },
} as const satisfies Record<string, { label: string; record: string }>

export type TelemetrySignal = keyof typeof SIGNALS

type Row = Record<TelemetrySignal, TelemetryDeclaration>

const captured: TelemetryDeclaration = { state: 'captured' }
const notProduced: TelemetryDeclaration = { state: 'not-produced' }
const dropped = (note?: string): TelemetryDeclaration => ({
  state: 'dropped',
  ...(note ? { note } : {}),
})
const partial = (note: string): TelemetryDeclaration => ({ state: 'partial', note })

const MODEL_VIEW =
  "the CLI's truncated view, which the model saw; the full output is spilled to disk"
const NO_SYSTEM_PROMPT = dropped('on the wire; the record keeps no request shape')
const NOT_COMPACTED: TelemetryDeclaration = {
  state: 'not-produced',
  note: 'no contract run compacts context',
  unverified: true,
}

/** Each harness's declaration on main; a PR that closes a gap updates its own cells. */
export const TELEMETRY: Record<AgentKind, Row> = {
  cursor: {
    turnTokens: {
      state: 'captured',
      note: 'from the SDK only; reeval totals it, since the raw `totalTokens` counts cache reads twice',
      unverified: true,
    },
    cacheRead: { state: 'captured', note: 'from the SDK only', unverified: true },
    cacheWrite: { state: 'captured', note: 'from the SDK only', unverified: true },
    reasoningTokens: notProduced,
    reasoningText: captured,
    perCallUsage: dropped('the SDK and `agent-store` keep turn totals only'),
    sideCallUsage: { state: 'dropped', note: 'the wire is protobuf', unverified: true },
    servedModel: {
      state: 'dropped',
      note: "the gateway can't read the protobuf requests; the record has the SDK's turn model",
      unverified: true,
    },
    cost: notProduced,
    abortedUsage: dropped('`usage: null`'),
    abortedTranscript: captured,
    largeShellOutput: dropped(
      '`""`; the full output is in `~/.cursor/projects/*/agent-tools/*.txt`',
    ),
    largeMcpResult: dropped('`""`; spilled like the shell output'),
    mcpCall: captured,
    contextWindow: notProduced,
    systemPrompt: NO_SYSTEM_PROMPT,
    rateLimits: { state: 'dropped', note: 'the wire is protobuf', unverified: true },
    compaction: NOT_COMPACTED,
  },
  'claude-code': {
    turnTokens: captured,
    cacheRead: captured,
    cacheWrite: captured,
    reasoningTokens: dropped(
      "`thinking_tokens` in `message_delta`, the session JSONL and `modelUsage`; the catalog's `reasoningTokens: false`",
    ),
    reasoningText: captured,
    perCallUsage: dropped('in the raw `finish-step` parts'),
    sideCallUsage: dropped('`WebSearch` is its own `/v1/messages` call, in `modelUsage` only'),
    servedModel: dropped(
      "the gateway doesn't read Anthropic responses; the record has the CLI's turn model",
    ),
    cost: dropped('`result.modelUsage[*].costUSD`'),
    abortedUsage: captured,
    abortedTranscript: captured,
    largeShellOutput: partial(MODEL_VIEW),
    largeMcpResult: partial(
      'a "saved to …" notice, which the model saw; the result is in `tool-results/`',
    ),
    mcpCall: captured,
    contextWindow: dropped(),
    systemPrompt: NO_SYSTEM_PROMPT,
    rateLimits: dropped('`anthropic-ratelimit-*` headers on every call'),
    compaction: NOT_COMPACTED,
  },
  codex: {
    turnTokens: captured,
    cacheRead: captured,
    cacheWrite: captured,
    reasoningTokens: captured,
    reasoningText: {
      state: 'not-produced',
      note: 'its `config.toml` sets no `model_reasoning_summary`, so reasoning comes back encrypted',
    },
    perCallUsage: dropped("the rollout JSONL's `token_count` events"),
    sideCallUsage: {
      state: 'not-produced',
      note: 'web search is `POST /v1/alpha/search`, which carries no usage',
    },
    servedModel: captured,
    cost: notProduced,
    abortedUsage: dropped("`usage: null`; the rollout JSONL has each call's `last_token_usage`"),
    abortedTranscript: captured,
    largeShellOutput: {
      state: 'captured',
      note: 'more than the model saw: the transcript has the full output',
    },
    largeMcpResult: captured,
    mcpCall: captured,
    contextWindow: dropped("the rollout's `model_context_window`"),
    systemPrompt: NO_SYSTEM_PROMPT,
    rateLimits: dropped("`x-ratelimit-*` headers on every call, and the rollout's rate limits"),
    compaction: {
      ...NOT_COMPACTED,
      note: 'no contract run compacts context; the rollout would show it',
    },
  },
  antigravity: {
    turnTokens: captured,
    cacheRead: captured,
    cacheWrite: notProduced,
    reasoningTokens: captured,
    reasoningText: dropped('on the wire, none in the transcript'),
    perCallUsage: dropped('turn totals only'),
    sideCallUsage: dropped(
      "the title and web-search calls on Flash Lite: the model's in `servedModels`, its tokens aren't",
    ),
    servedModel: captured,
    cost: notProduced,
    abortedUsage: partial("kept, without the title call's"),
    abortedTranscript: captured,
    largeShellOutput: partial(MODEL_VIEW),
    largeMcpResult: dropped(
      '`""`; the result is in `brain/<id>/.system_generated/steps/<n>/output.txt`',
    ),
    mcpCall: captured,
    contextWindow: notProduced,
    systemPrompt: NO_SYSTEM_PROMPT,
    rateLimits: notProduced,
    compaction: NOT_COMPACTED,
  },
  opencode: {
    turnTokens: partial(
      'fresh input is 0: `tokenUsage` subtracts cache reads from an already-uncached `inputTokens`',
    ),
    cacheRead: dropped('fresh input lands as 0, so the split is lost (see main-call tokens)'),
    cacheWrite: { state: 'captured', note: 'on Anthropic; Gemini writes none' },
    reasoningTokens: captured,
    reasoningText: {
      state: 'not-produced',
      note: 'on Gemini its config sends no `includeThoughts`; Anthropic returned no visible thinking',
    },
    perCallUsage: dropped("`opencode.db`'s `session_message.data.tokens`"),
    sideCallUsage: dropped('the session-title call'),
    servedModel: captured,
    cost: dropped('ACP `usage_update.cost`, and `opencode.db`'),
    abortedUsage: dropped("`usage: null`; `opencode.db` has the calls' tokens"),
    abortedTranscript: dropped(
      'no parts: harness-acp drops what it buffered when it abandons the turn',
    ),
    largeShellOutput: partial(MODEL_VIEW),
    largeMcpResult: partial('cut short with no end marker; the full result is in `tool-output/`'),
    mcpCall: partial('the result keeps its `{metadata, output}` wrapper'),
    contextWindow: dropped('ACP `usage_update.used` and `size`'),
    systemPrompt: NO_SYSTEM_PROMPT,
    rateLimits: notProduced,
    compaction: NOT_COMPACTED,
  },
  goose: {
    turnTokens: dropped(
      "`usage: null` (ACP's is the last call's); `sessions.db`'s `usage_ledger` has every call",
    ),
    cacheRead: dropped('`usage_ledger.cache_read_tokens`'),
    cacheWrite: dropped(),
    reasoningTokens: dropped('on the wire only'),
    reasoningText: captured,
    perCallUsage: dropped('`usage_ledger`, one row per model call'),
    sideCallUsage: dropped('the session-naming call, on the wire only (not in `usage_ledger`)'),
    servedModel: captured,
    cost: dropped('ACP `usage_update.cost`, and `usage_ledger.cost` (estimated)'),
    abortedUsage: dropped(),
    abortedTranscript: dropped(
      'no parts: harness-acp drops what it buffered when it abandons the turn',
    ),
    largeShellOutput: partial(MODEL_VIEW),
    largeMcpResult: captured,
    mcpCall: partial('the result keeps its ACP `content[]` wrapper'),
    contextWindow: dropped('ACP `usage_update.used` and `size`'),
    systemPrompt: NO_SYSTEM_PROMPT,
    rateLimits: notProduced,
    compaction: {
      ...NOT_COMPACTED,
      note: 'no contract run compacts context; `usage_ledger.is_compaction` would show it',
    },
  },
  pi: {
    turnTokens: captured,
    cacheRead: captured,
    cacheWrite: notProduced,
    reasoningTokens: captured,
    reasoningText: captured,
    perCallUsage: dropped('in the raw `finish-step` parts'),
    sideCallUsage: notProduced,
    servedModel: captured,
    cost: notProduced,
    abortedUsage: captured,
    abortedTranscript: captured,
    largeShellOutput: partial(MODEL_VIEW),
    largeMcpResult: partial(MODEL_VIEW),
    mcpCall: partial('the result keeps its `{output, details}` wrapper'),
    contextWindow: notProduced,
    systemPrompt: NO_SYSTEM_PROMPT,
    rateLimits: notProduced,
    compaction: NOT_COMPACTED,
  },
  fx: {
    turnTokens: partial('on Chat Completions, input counts cache reads as fresh'),
    cacheRead: dropped(
      "ACP sends no cache field; the wire's `prompt_tokens_details.cached_tokens`",
    ),
    cacheWrite: notProduced,
    reasoningTokens: dropped(
      "on Chat Completions, the wire's `completion_tokens_details.reasoning_tokens` only",
    ),
    reasoningText: notProduced,
    perCallUsage: dropped('on the wire only'),
    sideCallUsage: notProduced,
    servedModel: captured,
    cost: notProduced,
    abortedUsage: dropped(),
    abortedTranscript: dropped(
      'no parts: harness-acp drops what it buffered when it abandons the turn',
    ),
    largeShellOutput: {
      state: 'captured',
      note: 'more than the model saw: the transcript has the full output',
    },
    largeMcpResult: partial('a pointer the model follows with `read_tool_result`'),
    mcpCall: partial('the result keeps its `{server, tool, result}` wrapper'),
    contextWindow: notProduced,
    systemPrompt: NO_SYSTEM_PROMPT,
    rateLimits: notProduced,
    compaction: NOT_COMPACTED,
  },
  'grok-build': {
    turnTokens: captured,
    cacheRead: captured,
    cacheWrite: notProduced,
    reasoningTokens: captured,
    reasoningText: captured,
    perCallUsage: dropped('on the wire, and per turn in `usage.json`'),
    sideCallUsage: dropped(
      "`session_title` and the server-side `web_search` call, the larger share of a searching attempt's cost",
    ),
    servedModel: captured,
    cost: dropped('`usage.cost_in_usd_ticks` on every response, and `usage.json`'),
    abortedUsage: dropped("`usage: null`; `sessions/<cwd>/<id>/usage.json` has the turn's"),
    abortedTranscript: dropped(
      'no parts: harness-acp drops what it buffered when it abandons the turn',
    ),
    largeShellOutput: partial(MODEL_VIEW),
    largeMcpResult: partial('cut short'),
    mcpCall: captured,
    contextWindow: dropped(),
    systemPrompt: NO_SYSTEM_PROMPT,
    rateLimits: notProduced,
    compaction: NOT_COMPACTED,
  },
}

const CELL: Record<TelemetryState, string> = {
  captured: 'captured',
  partial: 'partial',
  dropped: '**dropped**',
  'not-produced': 'n/p',
}

/** The README's table: a signal per row, a harness per column, then the notes, each once. */
export const renderTelemetry = (agents: Record<AgentKind, { name: string }>): string => {
  const kinds = Object.keys(TELEMETRY) as AgentKind[]
  const notes: string[] = []
  const rows = (Object.keys(SIGNALS) as TelemetrySignal[]).map((signal) => {
    const cells = kinds.map((kind) => {
      const d = TELEMETRY[kind][signal]
      const mark = d.unverified ? '?' : ''
      if (!d.note) return `${CELL[d.state]}${mark}`
      if (!notes.includes(d.note)) notes.push(d.note)
      return `${CELL[d.state]}${mark} [${notes.indexOf(d.note) + 1}]`
    })
    return `| ${SIGNALS[signal].label} | ${cells.join(' | ')} |`
  })
  return [
    `| Signal | ${kinds.map((k) => agents[k].name).join(' | ')} |`,
    `|---|${kinds.map(() => '---').join('|')}|`,
    ...rows,
    '',
    ...notes.map((note, i) => `${i + 1}. ${note[0]?.toUpperCase()}${note.slice(1)}.`),
    '',
    '| Signal | What the record holds when captured |',
    '|---|---|',
    ...Object.values(SIGNALS).map((s) => `| ${s.label} | ${s.record} |`),
  ].join('\n')
}
