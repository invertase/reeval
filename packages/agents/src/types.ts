// What a harness reports for each turn: its transcript events, token usage, cost and status.

/** When an event started: wall clock, and ms since its turn started. */
export type EventTime = { ts: string; atMs: number }

export type FileEditEvent = {
  type: 'file-edit'
  toolCallId: string
  path: string
  /**
   * `write` is a whole-file write whose result doesn't say whether the file existed before
   * (Antigravity's, fx's, Goose's, Grok Build's and pi's write tools, for example).
   */
  kind: 'create' | 'modify' | 'write' | 'delete'
  /** Line counts, or null when the harness didn't send the content (e.g. deletes). */
  added: number | null
  removed: number | null
}

/**
 * Normalized agent events. Each tool call is one event, merged with its result; `durationMs`
 * is wall time until the result arrived (Cursor's own `completed_at_ms` can be earlier). Null
 * when the harness never reported the end. Long shell or edit calls set `stalled: true`. A
 * call the harness never reported a result for (the turn ended or was cut short first) has
 * `ok: null`: it isn't known to have failed, and no failure count includes it.
 */
export type TranscriptEvent = EventTime &
  (
    | { type: 'text' | 'reasoning'; text: string; durationMs: number | null }
    | (FileEditEvent & {
        durationMs: number | null
        /** True when a shell-like tool or edit ran at least two minutes. */
        stalled?: boolean
        /**
         * Set when the harness never reported the call's end, so `durationMs` runs to the next
         * event's `atMs` (the turn's end for the last).
         */
        durationInferred?: true
        /** The `toolCallId` of the subagent call whose agent made this call; absent for the agent's own. */
        subagent?: string
      })
    | {
        type: 'web-search'
        toolCallId: string
        query: string
        /** How many sources the harness says it used; Cursor sends no URLs or titles. */
        references: number | null
        /**
         * Whether the search succeeded. Absent means it did; null means the harness never
         * reported its result.
         */
        ok?: boolean | null
        durationMs: number | null
        /** True when a shell-like tool or edit ran at least two minutes. */
        stalled?: boolean
        /**
         * Set when the harness never reported the call's end, so `durationMs` runs to the next
         * event's `atMs` (the turn's end for the last).
         */
        durationInferred?: true
        /** The `toolCallId` of the subagent call whose agent made this call; absent for the agent's own. */
        subagent?: string
      }
    | {
        type: 'web-fetch'
        toolCallId: string
        url: string
        /** Whether the fetch succeeded; null when the harness never reported its result. */
        ok: boolean | null
        durationMs: number | null
        /** True when a shell-like tool or edit ran at least two minutes. */
        stalled?: boolean
        /**
         * Set when the harness never reported the call's end, so `durationMs` runs to the next
         * event's `atMs` (the turn's end for the last).
         */
        durationInferred?: true
        /** The `toolCallId` of the subagent call whose agent made this call; absent for the agent's own. */
        subagent?: string
      }
    | {
        type: 'tool'
        toolCallId: string
        tool: string
        input: unknown
        output: unknown
        /**
         * What `output` holds: `model`, the result as the harness gave it to the model; `full`,
         * the tool's whole output, which can be more than the model saw (the harness cut it for
         * the model, or saved it to a file and gave the model a pointer, which reeval read).
         */
        outputView?: 'model' | 'full'
        /**
         * Set when `output` is only part of the output, with a line where the rest was cut:
         * `transcript.jsonl` keeps the first 96K and last 16K characters of one past 128K (of its
         * JSON, for structured output), and the harness adapter keeps the first and last 512 KiB
         * of a saved output past 1 MiB. `bytes` is the whole output's size in UTF-8.
         */
        outputTruncated?: { bytes: number }
        /** Whether the call succeeded; null when the harness never reported its result. */
        ok: boolean | null
        durationMs: number | null
        /** True when a shell-like tool or edit ran at least two minutes. */
        stalled?: boolean
        /**
         * Set when the harness never reported the call's end, so `durationMs` runs to the next
         * event's `atMs` (the turn's end for the last).
         */
        durationInferred?: true
        /** The `toolCallId` of the subagent call whose agent made this call; absent for the agent's own. */
        subagent?: string
      }
    | { type: 'error'; message: string }
    /** A step that failed while the turn went on: a model call the harness retried. */
    | { type: 'retry'; message: string }
    | ModelCallEvent
  )

/**
 * One of the agent's calls to its model API, as the egress gateway saw it (in a sandbox behind
 * it, such as Docker's): when it started, when its response's first byte came (on a streamed call,
 * about its first token) and when it ended, with the tokens and the model its response named.
 * Cursor sends a whole turn over one long stream to `api2.cursor.sh` (`AgentService/RunSSE`),
 * so a Cursor turn has one call, with `stream: true`, its tool calls inside it and its tokens
 * only in the turn's `usage`.
 */
export type ModelCallEvent = {
  type: 'model-call'
  /** `POST api.anthropic.com/v1/messages`: the method, host and path. */
  request: string
  /** The response's HTTP status; null when none came. */
  status: number | null
  durationMs: number
  /** Milliseconds from the call's start to its response body's first byte; null when none came. */
  firstByteMs: number | null
  /** The tokens its response body named; null when it named none (Cursor's are protobuf). */
  usage: TokenUsage | null
  /** The model that served it, from its request or response; null when neither named one. */
  model: string | null
  /** Set on a call that carries the whole turn (Cursor's), so it isn't counted as model time. */
  stream?: true
  /**
   * `main` for one of the agent's own steps, `side` for a call its CLI made around them: a
   * session title, a web search's own model call, Antigravity's Flash Lite calls. A call is
   * `main` when its tokens are one of the turn's steps' as the harness reported them. Otherwise
   * it's `side` when its request declared at most one tool while another call in the attempt
   * declared more, or when another model served it than served the turn's other calls, and `main`
   * when neither holds. Absent in records from before roles.
   */
  role?: 'main' | 'side'
}

/** The transcript events a harness may be unable to report. */
export type WebEventType = 'web-search' | 'web-fetch'

export type TurnStatus = 'completed' | 'aborted' | 'error'

/**
 * The tokens one turn used, as its harness reported them. `input` excludes cache reads and
 * writes (so the prompt was `input + cacheRead + cacheWrite`); `reasoning` is part of `output`.
 */
export type TokenUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number | null
}

/** A dollar figure and where it came from. */
export type CostUsd = {
  /** US dollars. */
  usd: number
  /**
   * `reported`: what the harness (Claude Code, pi) or the gateway (OpenRouter) said it cost;
   * `estimated`: the tokens at list prices, which leave out discounts and long-context rates.
   */
  basis: 'reported' | 'estimated'
  /**
   * Who reported it (`claude-code`, `pi`, `openrouter`, `fake`), or the prices it was estimated
   * at (`models.dev 2026-11-05`, a `REEVAL_PRICES` file); several, joined with `, `, in a sum.
   */
  source: string
}

/**
 * The model provider ended a turn, not the agent: out of credit, over its quota, rate limited or
 * overloaded, with the HTTP status of the last model call the egress gateway brokered when that
 * call failed (`null` when it didn't, as in a stream that failed inside an HTTP 200, or none was).
 * The attempt is then an infra error, so `--retry-errors` runs it again.
 */
export type ProviderStopRecord = {
  cause: 'credit' | 'quota' | 'rate_limit' | 'overloaded'
  status: number | null
}
