import type { DeclaredSource } from './declaration.ts'
import type { ArtifactLevel, FileRef, JudgeRetry, RecordMode } from './history/types.ts'

/** More than zero and at most 596h: `90s`, `15m`, `1h`, or a number of milliseconds. */
export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h'}`

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
 * Normalised agent events. Each tool call is one event, merged with its result; `durationMs`
 * is wall time until the result arrived (Cursor's own `completed_at_ms` can be earlier). Null
 * when the harness never reported the end. Long shell or edit calls set `stalled: true`.
 */
export type TranscriptEvent = EventTime &
  (
    | { type: 'text' | 'reasoning'; text: string; durationMs: number | null }
    | (FileEditEvent & {
        durationMs: number | null
        /** True when a shell-like tool or edit ran at least two minutes. */
        stalled?: boolean
      })
    | {
        type: 'web-search'
        toolCallId: string
        query: string
        /** How many sources the harness says it used; Cursor sends no URLs or titles. */
        references: number | null
        /** Whether the search succeeded. Absent means it did. */
        ok?: boolean
        durationMs: number | null
        /** True when a shell-like tool or edit ran at least two minutes. */
        stalled?: boolean
      }
    | {
        type: 'web-fetch'
        toolCallId: string
        url: string
        ok: boolean
        durationMs: number | null
        /** True when a shell-like tool or edit ran at least two minutes. */
        stalled?: boolean
      }
    | {
        type: 'tool'
        toolCallId: string
        tool: string
        input: unknown
        output: unknown
        ok: boolean
        durationMs: number | null
        /** True when a shell-like tool or edit ran at least two minutes. */
        stalled?: boolean
      }
    | { type: 'error'; message: string }
    /** A step that failed while the turn went on: a model call the harness retried. */
    | { type: 'retry'; message: string }
  )

/** The transcript events a harness may be unable to report. */
export type WebEventType = 'web-search' | 'web-fetch'

export type ExecResult = { exitCode: number; stdout: string; stderr: string }

/** How `c.exec` reruns a command that exits non-zero, for a check that can fail on a transient. */
export type ExecRetry = {
  /** Extra tries after a non-zero exit, a whole number from 0. Default 0. */
  retries?: number
  /** Milliseconds to wait before each extra try. Default 1000. */
  interval?: number
}

/** One run of a `c.exec` command that had `retries`. */
export type ExecTry = { exitCode: number; durationMs: number }

/** Live tab size for `c.capture()`. Default 1280×720 when the call and cascade omit `viewport`. */
export type CaptureWindow = {
  /** In CSS pixels. */
  width: number
  /** In CSS pixels. */
  height: number
}

/**
 * Author camera. `{ width, height }` is the live window and the saved PNG.
 * `'full-page'` keeps the default window and saves with `captureBeyondViewport`.
 */
export type Viewport = CaptureWindow | 'full-page'

/**
 * Chromium look-ready events. `'load'` is `window` load (`Page.loadEventFired`).
 * `'idle'` is `Page.lifecycleEvent` `networkAlmostIdle`.
 */
export type CaptureWait = 'load' | 'idle'

/** Same shape at top-level `wait` and `{ wait }` between instructions. */
export type Wait = CaptureWait | { ms: number }

export type CaptureInstruction = string | { wait: Wait }

export type CaptureUseAction =
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: 'Tab' | 'Enter' }
  | { type: 'scroll'; x: number; y: number; dy: number }
  | { type: 'drag'; x: number; y: number; toX: number; toY: number }
  | { type: 'hover'; x: number; y: number }
  | { type: 'done' }

/** One list per instruction string. Tests; never downloads a model. */
export type CaptureUseScript = CaptureUseAction[][]

/** Resolved vision driver after cascade, call override and analysis fallback. */
export type CaptureUse = { model: string } | { fake: CaptureUseScript }

/**
 * Camera defaults for `c.capture()`. Cascades config → profile defaults → group → eval,
 * shallow-merged. `viewport` on a level replaces the whole value. `port` is not an option:
 * pass it as the first argument to `c.capture`.
 */
export type CaptureOptions = {
  /** The window and saved PNG size, or `'full-page'`. Default 1280×720. */
  viewport?: Viewport
  /** How long to poll before failing. Default `'60s'`. */
  timeout?: Duration
  /** `false` refuses the host `chrome-headless-shell` binary. `c.capture()` then throws. */
  browser?: boolean
  /**
   * Vision model for `instructions`. Cascades like `question`. Default is `analysis.model`, else
   * the attempt's judge model, whichever is first a language model; never Jev.
   */
  model?: string
}

/** A background process started by `c.exec(..., { background: true })` or `c.serve`. */
export type BackgroundHandle = {
  kill(): Promise<void>
}

/** `c.serve`: a background process plus the port it was given or allocated. */
export type ServeHandle = BackgroundHandle & { port: number }

/** What `c.capture()` returns: the PNG is also in the attempt record under `artifacts/`. */
export type Capture = {
  name: string
  /** Container port that was tunneled. */
  port: number
  /** Path on the app, as passed in. */
  path: string
  /** What the author asked, including `'full-page'`. */
  viewport: Viewport
  /** `artifacts/<name>.png` under the attempt directory. */
  file: { path: string; sha256: string; bytes: number }
}

/**
 * Optional camera and path for `c.capture(port | ServeHandle, options?)`.
 * `port` is the first argument, not a field here. Default `path` is `/`;
 * default `name` is derived from the path. `wait` and `instructions` are call-only.
 */
export type CaptureCall = {
  /** The `artifacts/<name>.png` file name: 1 to 100 of `a-z`, `0-9`, `_` and `-`, starting with a letter or digit. Unique within the attempt. */
  name?: string
  path?: string
  viewport?: Viewport
  timeout?: Duration
  /** Look-ready once, before the first model shot or the saved PNG. Default `'load'`. */
  wait?: Wait
  /** Journey: goal strings and `{ wait }` beats. Tests may pass `fakeInstructions(...)`. */
  instructions?: CaptureInstruction[]
  /** Overrides cascaded `capture.model` for this call. */
  model?: string
}

export type FileChange = { path: string; status: 'added' | 'modified' | 'deleted' }
export type Diff = { patch: string; files: FileChange[] }

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

/** One agent turn. Immutable once `c.send()` resolves. */
/** A turn as data, as a record or another language's runner carries it: `Turn` without its methods. */
export type TurnData = {
  prompt: string
  /** The agent's final message for this turn. */
  text: string
  status: TurnStatus
  startedAt: string
  durationMs: number
  transcript: TranscriptEvent[]
  /** Tokens the turn used; null when the harness reports none. */
  usage: TokenUsage | null
  /**
   * The model the harness says served the turn, e.g. `composer-2.5[fast=false]`; null when it
   * reports none. It can differ from the requested one (an alias, or parameters it filled in).
   */
  model: string | null
  /**
   * Event types the harness couldn't report for this turn: the agent may have searched or
   * fetched with no event in `transcript`. `toHaveSearched()` and `toHaveFetched()` refuse
   * such a turn. Usually `[]`; a Cursor turn
   * whose web calls the adapter couldn't recover (its SDK drops them from the stream) is
   * `['web-search', 'web-fetch']`.
   */
  unreported: WebEventType[]
  /** Workspace changes since the eval started, as of the end of this turn. */
  diff: Diff
}

export type Turn = TurnData & {
  /** Runs in the eval's sandbox. Same as `c.exec`. */
  exec(command: string, options?: ExecRetry): Promise<ExecResult>
  readFile(path: string): Promise<string | null>
}

/** Any JSON value. */
export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue }

/** JSON fields the judge sees for the turn: task, output, files, diff, optional contents. */
export type JudgeJsonState = { [key: string]: JSONValue }

/** A capture sent to `experimental_decide` as a file part. */
export type JudgeFilePart = {
  type: 'file'
  mediaType: string
  data: Uint8Array
}

/**
 * What `experimental_decide` (and a fake judge) receive: a JSON object when the call has no
 * captures, or an ordered list of one JSON part plus each capture's file part.
 */
export type JudgeState =
  | JudgeJsonState
  | Array<{ type: 'json'; value: JudgeJsonState } | JudgeFilePart>

/** A capture this judge call sent as a file part. Bytes live in `artifacts/<name>.png`. */
export type JudgeArtifactRef = {
  name: string
  /** `artifacts/<name>.png` under the attempt directory. */
  path: string
  sha256: string
  bytes: number
  mediaType: 'image/png'
}

/**
 * A canned judge for tests and dry runs; see `fakeJudge()` in `reeval/judge`. `score` as a
 * function of the state the judge would see works per group, eval or call, not in the config.
 */
export type FakeJudgeModel = {
  kind: 'fake-judge'
  /** The score (0–1) every call gets, or a function of the state it would see. */
  score: number | ((state: JudgeState) => number)
}

/**
 * `'provider/model'` (e.g. `'typesafe-ai/jev-1.14.0'`, `'google/gemini-3.8-flash'`), an AI SDK
 * decision model object (per group, eval or call only), or a fake judge.
 */
export type JudgeModel = string | FakeJudgeModel | { readonly specificationVersion: string }

/** Merged field by field down the cascade, so per-model settings can join as new fields. */
export type JudgeOptions = {
  /** The model that grades. */
  model?: JudgeModel
  /** Minimum score (0–1) for a `pass` verdict. */
  threshold?: number
  /** AI SDK provider options for the judge's calls, keyed by provider. */
  providerOptions?: Record<string, Record<string, JSONValue>>
  /** The most judge calls to this model's provider at once, across the run. */
  maxConcurrent?: number
  /**
   * The judge's state: what the judge is given beside the question, not the workspace's or the
   * attempt's state. Merged key by key down the cascade.
   */
  state?: JudgeStateOptions
  /**
   * The gateway the judge's calls go through, by name or by its helper. It skips the config's
   * `gateway` fallback: the plan refuses a gateway that isn't listed or can't serve the model.
   */
  gateway?: GatewayName | GatewayDescriptor
}

/**
 * What the judge is given: each key is a key of the state in `judge-input.json`. An unset key
 * keeps its default, which is what the judge gets with no `state` option at all.
 */
export type JudgeStateOptions = {
  /** The graded turn's prompt. Default true. */
  task?: boolean
  /** The graded turn's final message, or `on`'s value. Default true. */
  output?: boolean
  /** `status path` lines for the changed files, under `diff`'s patterns. Default true. */
  files?: boolean
  /**
   * The diff since the eval started. A list is gitignore-style patterns over workspace paths:
   * the last matching pattern wins and `!` excludes. Default true.
   */
  diff?: boolean | string[]
  /**
   * Workspace files shown whole, as they are now, changed or not: exact paths or gitignore-style
   * patterns (`'**'`, `'src/**'`; the last match wins, `!` excludes) over the files git sees in
   * the workspace. A missing exact path is `null`; a pattern that matches nothing adds nothing.
   * These files leave the diff. Default none.
   */
  contents?: string[]
  /**
   * The graded turn's transcript as text lines: `true` is messages and tool calls with tool
   * output clipped, `'tools'` tool calls only, `'full'` adds reasoning and whole tool output.
   * Default false.
   */
  transcript?: boolean | 'tools' | 'full'
  /**
   * `'all'`: every turn up to the graded one under `turns`, each with its task, output and (with
   * `transcript`) transcript. Default `'last'`.
   */
  turns?: 'last' | 'all'
  /** `c.exec` results so far; a list shows only those commands, as passed to `c.exec`. Default false. */
  checks?: boolean | string[]
}

/** `JudgeStateOptions` with every key set: what one judge call saw. */
export type ResolvedJudgeStateOptions = {
  task: boolean
  output: boolean
  files: boolean
  diff: boolean | string[]
  contents: string[]
  transcript: boolean | 'tools' | 'full'
  turns: 'last' | 'all'
  checks: boolean | string[]
}

export type JudgeCallOptions = JudgeOptions & {
  /** What to grade instead of the latest turn: another turn, or a value used as the output. */
  on?: Turn | JSONValue
  /**
   * Captures this call sends the judge as file parts: `c.capture()` handles or their names, or
   * `true` for every capture so far. Call-only: the bytes are on this attempt. Jev takes PNG
   * captures; a provider that cannot take files fails the call.
   */
  artifacts?: true | Array<Capture | string>
}

export type Verdict = {
  verdict: 'pass' | 'fail'
  /** The judge's probability that the answer is yes, from 0 to 1. */
  score: number
  threshold: number
  question: string
  model: string
  /** The model id the provider says served the call, when it reports one. */
  resolvedModel?: string
  /** The gateway from the config's `gateway` list the call went through; unset without one. */
  gateway?: GatewayName
  /** The upstream provider the gateway says served the call (OpenRouter's); unset when it names none. */
  upstream?: string
  /** What the gateway says the call cost, in US dollars (OpenRouter's `usage.cost`); unset when it names none. */
  costUsd?: number
  /** Captures this call sent the judge as file parts, when any. */
  artifacts?: JudgeArtifactRef[]
}

/**
 * What `c.judge()` returns when the call failed (the provider's error, after any retries): the attempt fails as a judge error once the eval's body has finished,
 * so the judges and checks after it still run.
 */
export type JudgeFailure = Omit<
  Verdict,
  'verdict' | 'score' | 'resolvedModel' | 'upstream' | 'costUsd'
> & {
  verdict: 'error'
  score: null
  error: string
}

/**
 * What an eval's body gets. The sandbox and the agent session start on the first call that needs
 * them (`send`, `exec`, `readFile`, `writeFile`, `serve` or `capture`), once however many ask.
 */
export type AttemptContext = {
  /** Sends the next turn of this eval's agent session. */
  send(prompt: string): Promise<Turn>
  /**
   * Asks the judge a yes/no question about the latest turn (or `options.on`).
   * `options.artifacts` is a list of `c.capture()` handles or names, or `true` for all of them.
   */
  judge(question: string, options?: JudgeCallOptions): Promise<Verdict | JudgeFailure>
  /**
   * Runs `command` in the sandbox. With `retries`, a non-zero exit runs it again, up to that
   * many extra times, `interval` ms apart; it resolves with the last try.
   */
  exec(command: string, options?: ExecRetry & { background?: false }): Promise<ExecResult>
  exec(command: string, options: { background: true }): Promise<BackgroundHandle>
  exec(
    command: string,
    options?: ExecRetry & { background?: boolean },
  ): Promise<ExecResult | BackgroundHandle>
  /**
   * Starts `command` in the background and returns its port. A given `port` is used; omit it
   * and reeval allocates one. Sets `PORT` so a bash string can use `$PORT`.
   */
  serve(command: string, port?: number): Promise<ServeHandle>
  /**
   * Screenshots a path on a tunneled sandbox port and writes `artifacts/<name>.png`.
   * First argument is the container port or a `ServeHandle` from `c.serve`.
   * `instructions` runs a vision journey on that same tab first.
   */
  capture(target: number | ServeHandle, options?: CaptureCall): Promise<Capture>
  /** Workspace-relative, or `~/` for the home directory; `null` when there's no such file. */
  readFile(path: string): Promise<string | null>
  /**
   * Writes a file into the sandbox (workspace-relative, or `~/`), creating its directories.
   * Later turns' `diff` leaves it out, as it does the environment's files, but shows any change
   * made to it afterwards.
   */
  writeFile(path: string, contents: string | Uint8Array): Promise<void>
  /** Every turn so far, oldest first. */
  readonly turns: readonly Turn[]
  /** Aborted on timeout or Ctrl-C. */
  readonly signal: AbortSignal
  /** Which cell of the matrix this attempt is, and its run number (from 1). */
  readonly attempt: { id: string; cell: Cell; n: number }
}
export type EvalFn = (c: AttemptContext) => Promise<void>

/** A canned agent for tests and dry runs, made by `fakeHarness()` in `reeval/harness`. */
export type FakeHarnessDescriptor = {
  kind: 'fake'
  /**
   * The gateway this harness's model calls go through, by name. It skips the config's `gateway`
   * fallback: the plan refuses a gateway that isn't listed or can't serve this harness.
   */
  gateway?: GatewayName
  /** Cell id; defaults to `fake`. */
  id?: string
  /** Files the fake agent writes into the sandbox on every turn. */
  files?: Record<string, string>
  /** The fake agent's final message on every turn; default `Done.`. */
  text?: string
  /** Simulated turn length, honours the abort signal. */
  delayMs?: number
  /** Sits out `delayMs` even after an abort, like an agent that doesn't stop when it's told to. */
  ignoreAbort?: boolean
  /** Throw before the first turn starts, to simulate an infra failure. */
  failWith?: string
  /** The first this many session starts of an attempt never become ready, even when aborted (`true`: every one). */
  startHangs?: number | true
  /** A reasoning block at the start of every turn. */
  reasoning?: string
  /**
   * The model the fake agent says served each turn, as a real harness reports its resolved model
   * and variant (`composer-2.5[fast=true]`); unset, it reports none.
   */
  servedModel?: string
  /**
   * Requested reasoning effort, recorded as `effort` on the cell. Use `servedModel` for what the
   * turn reports (`fake-1[effort=medium]`). Fast is not this.
   */
  effort?: string
  /** Tool calls the fake agent reports on every turn, before writing files. */
  tools?: Array<{ tool: string; input: unknown; output: unknown; ok?: boolean }>
  /** Files and message used instead when the environment gives the agent a skill. */
  withSkill?: { files?: Record<string, string>; text?: string }
  /** Chance (0–1) that an attempt writes no files and says so, for flaky pass rates. */
  flakeRate?: number
  /**
   * Real sandbox actions, one list per `c.send` (the last list repeats), run in order before
   * `files`. `exec` runs as the agent: with the sandbox's own variables, none of the checks'.
   */
  script?: FakeScriptStep[][]
  /** The most attempts on this harness kind at once, across the run. */
  maxConcurrent?: number
  /**
   * How long the harness's session may take to become ready (its bootstrap and first session)
   * before the attempt is an infra error, after one retry; default 90s.
   */
  startTimeout?: Duration
  /**
   * Behave like this agent: its image, and where it reads rules and skills (`CLAUDE.md` and
   * `.claude/skills` for `claude-code`, `~/.gemini/config/skills` for `antigravity`,
   * `~/.config/opencode/skills` for `opencode`, Goose's private home for `goose`,
   * `~/.pi/agent/skills` for `pi`, `~/.agents/skills` for `codex`, fx's private home for
   * `fx`, Grok's private home for `grok-build`). Defaults to the fake's own (`AGENTS.md`,
   * `.agents/skills`) in Cursor's image.
   */
  layout?:
    | 'cursor'
    | 'claude-code'
    | 'antigravity'
    | 'opencode'
    | 'goose'
    | 'pi'
    | 'codex'
    | 'fx'
    | 'grok-build'
}
/**
 * One action of a scripted fake agent. `exec` is reported as a `shell` tool call whose output is
 * the command's stdout, `write` as file edits, and `reply` is the turn's final message. `mcp`
 * (`'<server>/<tool>'`) starts the environment's stdio MCP server in the sandbox, as an agent
 * would, and calls the tool with no arguments; it's reported as `mcp__<server>__<tool>`.
 * `error` ends the turn there with status `error` and that message, as a provider error would.
 */
export type FakeScriptStep =
  | { exec: string }
  | { write: Record<string, string> }
  | { reply: string }
  | { mcp: string }
  | { error: string }
/**
 * Cursor's agent through the Cursor TypeScript SDK's local runtime
 * (`@reeval/harness-cursor-sdk`), made by `cursor()`. It reports each turn's tokens.
 */
export type CursorHarnessDescriptor = {
  kind: 'cursor'
  /**
   * The gateway this harness's model calls go through, by name. It skips the config's `gateway`
   * fallback: the plan refuses a gateway that isn't listed or can't serve this harness.
   */
  gateway?: GatewayName
  /** A model id `Cursor.models.list()` returns for the key, e.g. `composer-2.5`. */
  model: string
  /**
   * Model parameters, e.g. `{ fast: 'true' }`. Unset ones take the default variant in Cursor's
   * model catalog, sent explicitly, except `fast`, which is `false` wherever the model takes it.
   */
  params?: Record<string, string>
  /**
   * Reasoning effort, mapped onto the catalog param `Cursor.models.list()` names for this model
   * (`reasoning_effort`, `effort`, …). Not Fast: that stays `params.fast`.
   */
  effort?: string
  /** Cell id; defaults to `cursor:<model>`, or `cursor:<model>[effort=<value>]` when `effort` is set. */
  id?: string
  /** The most Cursor attempts at once, across the run, e.g. for the account's rate limits. */
  maxConcurrent?: number
  /**
   * How long the harness's session may take to become ready (its bootstrap and first session)
   * before the attempt is an infra error, after one retry; default 90s.
   */
  startTimeout?: Duration
}
/** Reasoning effort the Claude Code Agent SDK `/effort` control takes. */
export type ClaudeCodeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Claude Code through `@ai-sdk/harness-claude-code`, made by `claudeCode()`. */
export type ClaudeCodeHarnessDescriptor = {
  kind: 'claude-code'
  /**
   * The gateway this harness's model calls go through, by name. It skips the config's `gateway`
   * fallback: the plan refuses a gateway that isn't listed or can't serve this harness.
   */
  gateway?: GatewayName
  /** A model id or alias the `claude` CLI accepts, e.g. `claude-sonnet-5` or `sonnet`. */
  model: string
  /**
   * Reasoning effort the Agent SDK `/effort` control takes: `low`, `medium`, `high`,
   * `xhigh` (Extra in the UI) or `max`.
   */
  effort?: ClaudeCodeEffort
  /** Cell id; defaults to `claude-code:<model>`, or `claude-code:<model>[effort=<value>]` when `effort` is set. */
  id?: string
  /** The most Claude Code attempts at once, across the run, e.g. for the account's rate limits. */
  maxConcurrent?: number
  /**
   * How long the harness's session may take to become ready (its bootstrap and first session)
   * before the attempt is an infra error, after one retry; default 90s.
   */
  startTimeout?: Duration
}
/** The Antigravity CLI through `@reeval/harness-antigravity`, made by `antigravity()`. */
export type AntigravityHarnessDescriptor = {
  kind: 'antigravity'
  /**
   * The gateway this harness's model calls go through, by name. It skips the config's `gateway`
   * fallback: the plan refuses a gateway that isn't listed or can't serve this harness.
   */
  gateway?: GatewayName
  /** A model slug `agy models` lists for a Gemini API key, e.g. `gemini-3.8-flash-medium`. */
  model: string
  /**
   * Reasoning effort passed as `agy --effort`, e.g. `low`, `medium`, `high` or `max`. The
   * slug's `-low`/`-medium`/`-high` suffix is the same knob baked into `model`.
   */
  effort?: string
  /** Cell id; defaults to `antigravity:<model>`, or `antigravity:<model>[effort=<value>]` when `effort` is set. */
  id?: string
  /** The most Antigravity attempts at once, across the run, e.g. for the key's rate limits. */
  maxConcurrent?: number
  /**
   * How long the harness's session may take to become ready (its bootstrap and first session)
   * before the attempt is an infra error, after one retry; default 90s.
   */
  startTimeout?: Duration
}
/**
 * OpenCode through `@reeval/harness-opencode` (`opencode acp`), made by `opencode()`. It runs
 * on any provider whose key OpenCode sends in a header on known hosts, with that provider's key,
 * and reports no usage (its ACP server counts one call).
 */
export type OpenCodeHarnessDescriptor = {
  kind: 'opencode'
  /**
   * The gateway this harness's model calls go through, by name. It skips the config's `gateway`
   * fallback: the plan refuses a gateway that isn't listed or can't serve this harness.
   */
  gateway?: GatewayName
  /**
   * OpenCode's model id, `<provider>/<model>`, e.g. `google/gemini-3.8-flash` or
   * `anthropic/claude-haiku-4-5`; the provider picks the key.
   */
  model: string
  /**
   * Reasoning effort for that provider: `options.reasoningEffort` (OpenAI) or `options.thinking`
   * (Anthropic). Values are whatever that provider takes.
   */
  effort?: string
  /** Cell id; defaults to `opencode:<model>`, or `opencode:<model>[effort=<value>]` when `effort` is set. */
  id?: string
  /** The most OpenCode attempts at once, across the run, e.g. for the key's rate limits. */
  maxConcurrent?: number
  /**
   * How long the harness's session may take to become ready (its bootstrap and first session)
   * before the attempt is an infra error, after one retry; default 90s.
   */
  startTimeout?: Duration
}
/**
 * Goose through `@reeval/harness-goose` (`goose acp`), made by `goose()`. It runs Google models
 * on a Gemini API key, and reports no usage (its ACP server counts one call).
 */
export type GooseHarnessDescriptor = {
  kind: 'goose'
  /**
   * The gateway this harness's model calls go through, by name. It skips the config's `gateway`
   * fallback: the plan refuses a gateway that isn't listed or can't serve this harness.
   */
  gateway?: GatewayName
  /** A Gemini model id, run on Goose's `google` provider, e.g. `gemini-3.8-flash`. */
  model: string
  /**
   * Reasoning effort as `GOOSE_THINKING_EFFORT`, e.g. `off`, `low`, `medium`, `high` or `max`.
   */
  effort?: string
  /** Cell id; defaults to `goose:<model>`, or `goose:<model>[effort=<value>]` when `effort` is set. */
  id?: string
  /** The most Goose attempts at once, across the run, e.g. for the key's rate limits. */
  maxConcurrent?: number
  /**
   * How long the harness's session may take to become ready (its bootstrap and first session)
   * before the attempt is an infra error, after one retry; default 90s.
   */
  startTimeout?: Duration
}
/**
 * pi through `@reeval/harness-pi` (`pi --mode json` in the sandbox), made by `pi()`. It runs
 * Google models on a Gemini API key and reports each model call's tokens. It takes stdio and
 * HTTP MCP servers, not SSE ones.
 */
export type PiHarnessDescriptor = {
  kind: 'pi'
  /**
   * The gateway this harness's model calls go through, by name. It skips the config's `gateway`
   * fallback: the plan refuses a gateway that isn't listed or can't serve this harness.
   */
  gateway?: GatewayName
  /** A Gemini model id, run on pi's `google` provider, e.g. `gemini-3.8-flash`. */
  model: string
  /**
   * Reasoning effort, passed as pi's `--thinking` (the CLI's name). Values are whatever that
   * flag takes, e.g. `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`.
   */
  effort?: string
  /** Cell id; defaults to `pi:<model>`, or `pi:<model>[effort=<value>]` when `effort` is set. */
  id?: string
  /** The most pi attempts at once, across the run, e.g. for the key's rate limits. */
  maxConcurrent?: number
  /**
   * How long the harness's session may take to become ready (its bootstrap and first session)
   * before the attempt is an infra error, after one retry; default 90s.
   */
  startTimeout?: Duration
}
/**
 * OpenAI's Codex CLI through `@reeval/harness-codex` (`codex exec --json`), made by `codex()`.
 * It runs OpenAI models on an OpenAI API key and reports each turn's tokens, reasoning included.
 */
export type CodexHarnessDescriptor = {
  kind: 'codex'
  /**
   * The gateway this harness's model calls go through, by name. It skips the config's `gateway`
   * fallback: the plan refuses a gateway that isn't listed or can't serve this harness.
   */
  gateway?: GatewayName
  /** An OpenAI model id Codex runs on the Responses API, e.g. `gpt-5.6-luna`. */
  model: string
  /**
   * Reasoning effort as Codex's `model_reasoning_effort`, e.g. `low`, `medium`, `high`,
   * `xhigh`, `max` or `ultra`.
   */
  effort?: string
  /** Cell id; defaults to `codex:<model>`, or `codex:<model>[effort=<value>]` when `effort` is set. */
  id?: string
  /** The most Codex attempts at once, across the run, e.g. for the key's rate limits. */
  maxConcurrent?: number
  /**
   * How long the harness's session may take to become ready (its bootstrap and first session)
   * before the attempt is an infra error, after one retry; default 90s.
   */
  startTimeout?: Duration
}
/**
 * fx through `@reeval/harness-fx` (`fx acp`), made by `fx()`. It runs on Vercel AI Gateway or
 * OpenAI's API by the model id, and reports each turn's tokens.
 */
export type FxHarnessDescriptor = {
  kind: 'fx'
  /**
   * The gateway this harness's model calls go through, by name. It skips the config's `gateway`
   * fallback: the plan refuses a gateway that isn't listed or can't serve this harness.
   */
  gateway?: GatewayName
  /**
   * A Vercel AI Gateway model id, `<provider>/<model>`, run on fx's `gateway` provider with
   * `AI_GATEWAY_API_KEY`, e.g. `anthropic/claude-sonnet-5`; or a bare OpenAI model id, run on
   * OpenAI's Chat Completions API with `OPENAI_API_KEY`, e.g. `gpt-5.5`. On `vertex()`, a Gemini
   * model id, with or without `google/`, run on Vertex AI's Chat Completions endpoint, e.g.
   * `google/gemini-3.8-flash`.
   */
  model: string
  /**
   * Reasoning effort, sent as `reasoning_effort` on each model call; only on `vertex()`, since fx
   * sends none itself. Values are what the model takes there, e.g. `low`, `medium` or `high`.
   */
  effort?: string
  /** Cell id; defaults to `fx:<model>`, or `fx:<model>[effort=<value>]` when `effort` is set. */
  id?: string
  /** The most fx attempts at once, across the run, e.g. for the key's rate limits. */
  maxConcurrent?: number
  /**
   * How long the harness's session may take to become ready (its bootstrap and first session)
   * before the attempt is an infra error, after one retry; default 90s.
   */
  startTimeout?: Duration
}
/**
 * xAI's Grok Build through `@reeval/harness-grok-build` (`grok agent stdio`), made by
 * `grokBuild()`. It runs xAI models on an xAI API key and reports each turn's tokens.
 */
export type GrokBuildHarnessDescriptor = {
  kind: 'grok-build'
  /**
   * The gateway this harness's model calls go through, by name. It skips the config's `gateway`
   * fallback: the plan refuses a gateway that isn't listed or can't serve this harness.
   */
  gateway?: GatewayName
  /** An xAI model id Grok Build runs on the xAI API, e.g. `grok-4.6`. */
  model: string
  /**
   * Reasoning effort as Grok's `default_reasoning_effort`, e.g. `low`, `medium` or `high`, for a
   * model that takes one.
   */
  effort?: string
  /** Cell id; defaults to `grok-build:<model>`, or `grok-build:<model>[effort=<value>]` when `effort` is set. */
  id?: string
  /** The most Grok Build attempts at once, across the run, e.g. for the key's rate limits. */
  maxConcurrent?: number
  /**
   * How long the harness's session may take to become ready (its bootstrap and first session)
   * before the attempt is an infra error, after one retry; default 90s.
   */
  startTimeout?: Duration
}
/**
 * A gateway the config lists by name: `direct` is each provider's own key, as without `gateway`;
 * `vercel` is Vercel AI Gateway; `openrouter` is OpenRouter; `vertex` is
 * Google Cloud's Vertex AI.
 */
export type GatewayName = 'direct' | 'vercel' | 'openrouter' | 'vertex'

/** Each provider's own key, as without `gateway`: made by `direct()` in `reeval/gateway`. */
export type DirectGatewayDescriptor = {
  kind: 'direct'
}

/**
 * Vercel AI Gateway, with `AI_GATEWAY_API_KEY` (else `VERCEL_OIDC_TOKEN`): made by `vercel()` in
 * `reeval/gateway`. It serves Claude Code, Codex, Goose, pi, OpenCode, fx and Grok Build.
 */
export type VercelGatewayDescriptor = {
  kind: 'vercel'
}

/**
 * OpenRouter, with `OPENROUTER_API_KEY`: made by `openrouter()` in `reeval/gateway`. It serves
 * Claude Code, Codex, Goose, OpenCode and Grok Build.
 */
export type OpenRouterGatewayDescriptor = {
  kind: 'openrouter'
  /**
   * Let OpenRouter fail over to another upstream provider when the one it picked can't serve a
   * call. Off by default, so reeval's own calls (the judge, analysis, compare questions and
   * captures) send `allow_fallbacks: false`. The harnesses' calls take OpenRouter's own routing
   * either way.
   */
  fallbacks?: boolean
}

/** A model publisher on Vertex AI, which may serve its models in a region of its own. */
export type VertexPublisher = 'anthropic' | 'google' | 'xai'

/**
 * Google Cloud's Vertex AI, on Application Default Credentials: made by `vertex()` in
 * `reeval/gateway`.
 */
export type VertexGatewayDescriptor = {
  kind: 'vertex'
  /** The Google Cloud project the calls are billed to; defaults to `GOOGLE_CLOUD_PROJECT`. */
  project?: string
  /** The region the models are called in, e.g. `us-east5`; defaults to `global`. */
  location?: string
  /** A region per publisher, where it differs from `location`, e.g. `{ anthropic: 'us-east5' }`. */
  regions?: Partial<Record<VertexPublisher, string>>
}

/** One entry of the config's `gateway` list. */
export type GatewayDescriptor =
  | DirectGatewayDescriptor
  | VercelGatewayDescriptor
  | OpenRouterGatewayDescriptor
  | VertexGatewayDescriptor

/**
 * A `gateway` entry as data (`reeval.yaml`): its name, a one-key map from its name to its
 * settings, or the descriptor itself.
 */
export type GatewayEntryData =
  | GatewayName
  | { direct: Omit<DirectGatewayDescriptor, 'kind'> }
  | { vercel: Omit<VercelGatewayDescriptor, 'kind'> }
  | { openrouter: Omit<OpenRouterGatewayDescriptor, 'kind'> }
  | { vertex: Omit<VertexGatewayDescriptor, 'kind'> }
  | GatewayDescriptor

/** A real coding agent, driven through its AI SDK harness adapter. */
export type AgentHarnessDescriptor =
  | CursorHarnessDescriptor
  | ClaudeCodeHarnessDescriptor
  | AntigravityHarnessDescriptor
  | OpenCodeHarnessDescriptor
  | GooseHarnessDescriptor
  | PiHarnessDescriptor
  | CodexHarnessDescriptor
  | FxHarnessDescriptor
  | GrokBuildHarnessDescriptor
/** The agent an attempt runs: a real harness, or the fake one. */
export type HarnessDescriptor = FakeHarnessDescriptor | AgentHarnessDescriptor

/** A temp directory on the host instead of a container, made by `fakeSandbox()`. */
export type FakeSandboxDescriptor = {
  kind: 'fake'
  /** Cell id; defaults to `fake`. */
  id?: string
  /** Parent directory for the per-eval workspace (defaults to the OS temp dir). */
  dir?: string
  /** The most attempts on this sandbox kind at once, across the run. */
  maxConcurrent?: number
}
/** A local Docker container, made by `docker()`, or a Podman one, made by `podman()`. */
export type DockerSandboxDescriptor = {
  kind: 'docker'
  /** The container CLI the sandbox runs on: `podman` for `podman()`, Docker when unset. */
  engine?: 'docker' | 'podman'
  /**
   * Cell id; defaults to `docker` (`podman`), or `docker:<image>` for other images, plus an
   * install hash.
   */
  id?: string
  /** An image that already has the harness baked in, used as is. */
  image?: string
  /** A Debian or Ubuntu based toolchain image; reeval bakes Node and the harness on top, cached. */
  from?: string
  /**
   * A Dockerfile, absolute or relative to the directory of the file it's written in, built from its
   * directory with `REEVAL_BASE` set to reeval's sandbox image and cached by content hash.
   */
  dockerfile?: string
  /** Baked onto the sandbox image in one build container: in order, no secrets, no workspace. */
  install?: InstallStep[]
  /** The most Docker sandboxes at once, across the run, whatever their image. */
  maxConcurrent?: number
  /**
   * Run the agent, setup steps and checks as root, with the capabilities `apt-get` needs, instead
   * of the unprivileged `reeval` user. For evals that install system packages at run time.
   */
  root?: boolean
  /** Linux capabilities to add back, e.g. `['NET_RAW']`; every other one is dropped. */
  capabilities?: string[]
  /** The container's memory: `'4g'` (default), `'512m'`, or bytes. */
  memory?: string | number
  /**
   * Swap on top of `memory`, in the same units. Default: as much as `memory`; `0` makes `memory`
   * the hard ceiling. A host without swap has none to give.
   */
  swap?: string | number
  /** CPUs the container may use, fractions allowed. Default 2, capped at the Docker host's. */
  cpus?: number
  /** Processes and threads at once. Default 1024. */
  pids?: number
}
export type SandboxDescriptor = FakeSandboxDescriptor | DockerSandboxDescriptor

/**
 * A host environment variable, redacted everywhere reeval writes and recorded by name only. Made by
 * the `secret` helper of `defineEnvironment` and `defineConfig` callbacks.
 */
export type Secret = {
  kind: 'secret'
  /** The host variable; defaults to the key it's set under. */
  from?: string
  /** When the host variable is unset, skip it (the record says so) instead of failing. */
  optional?: boolean
  /** `agent` (default): the container's environment. `checks`: only `c.exec` and `setup` steps. */
  to?: 'agent' | 'checks'
  /**
   * Brokers the secret: the sandbox gets a per-attempt placeholder, and the Docker egress gateway
   * swaps in the real value only on HTTPS requests to these hosts (`*.example.com` for subdomains).
   */
  hosts?: string[]
  /** Where in a request to those hosts the gateway substitutes; defaults to `['header']`. */
  in?: SubstituteIn[]
}
/** `header` values, the `query` string, or the request `body`. */
export type SubstituteIn = 'header' | 'query' | 'body'
export type SecretOptions = {
  optional?: boolean
  to?: 'agent' | 'checks'
  hosts?: readonly string[]
  in?: readonly SubstituteIn[]
}
/** `secret.template('Bearer ${TOKEN}')`: host variables substituted into a string, for MCP headers. */
export type SecretTemplate = {
  kind: 'secret-template'
  /** The string, with `${NAME}` for each host variable to substitute. */
  template: string
}
/** A variable's value: a literal string, or a host secret. */
export type EnvValue = string | Secret
/** Environment variables by name. */
export type EnvVars = Record<string, EnvValue>

/** A file on the host, read when an attempt starts. Made by the `file` helper. */
export type HostFile = {
  kind: 'file'
  /** Its path on the host, absolute or relative to the directory of the file it's written in. */
  path: string
}

/** Options for the `directory` helper. */
export type DirectoryOptions = {
  /** A workspace-relative directory (or `~/…`) to place the files under, e.g. `'app'`. */
  into?: string
  /**
   * Ordered gitignore-style patterns over paths relative to the directory. A plain pattern
   * includes and a `!pattern` excludes; the last one that matches a file decides. With no plain
   * pattern, every file starts included. Matched with picomatch (`*`, `?`, `**`, `[…]`, `{a,b}`):
   * a pattern with a `/` in it (other than at the end) is anchored to the directory, one without
   * matches a name at any depth, and a trailing `/` matches a directory and everything in it.
   */
  glob?: string[]
  /** `false` walks into `DEFAULT_DIRECTORY_IGNORES` too. `.git` is always skipped. */
  defaultIgnores?: boolean
}

/** An MCP server the agent gets, made by the `mcp` helper: a command in the sandbox, or a URL. */
export type McpServer =
  | {
      kind: 'mcp'
      transport: 'stdio'
      /** The command that starts the server in the sandbox. */
      command: string
      args: string[]
      /** Variables the server process gets. */
      env: EnvVars
    }
  | {
      kind: 'mcp'
      /** Streamable HTTP, or the older SSE transport. */
      transport: 'http' | 'sse'
      url: string
      /** Request headers, with secrets brokered by the egress gateway. */
      headers: Record<string, string | Secret | SecretTemplate>
    }

/** `harness` (default): the agent's own skills, via its adapter. `workspace`: its repo skill dir. */
export type SkillPlacement = 'harness' | 'workspace'

/** Skills to place for the agent, made by the `skill` helper. */
export type SkillSource = { kind: 'skill'; placement: SkillPlacement } & (
  | {
      source: 'local'
      /** A host directory with a `SKILL.md`, or a directory of them. */
      path: string
      /** The skill names to keep; default every one found. */
      only?: string[]
      /** Paths in each skill directory to leave out, gitignore-style. */
      exclude?: string[]
    }
  | {
      source: 'git'
      /** As written: a URL, `github:owner/repo`, or a GitHub `/tree/<ref>/<path>` URL. */
      repo: string
      /** A branch, tag or commit SHA; unset is the remote's `HEAD`. */
      ref?: string
      /** The directory in the repository to read skills from. */
      path?: string
      /** The skill names to keep; default every one found. */
      only?: string[]
      /** Paths in each skill directory to leave out, gitignore-style. */
      exclude?: string[]
    }
  | {
      source: 'registry'
      /** A skills.sh id, `owner/repo@skill`. */
      id: string
      /** A git ref of the skill's repository. */
      version?: string
    }
  | {
      source: 'npm'
      /** A pinned npm package spec. */
      spec: string
      /** The directory in the package to read skills from; default `skills`. */
      path: string
      /** The skill names to keep; default every one found. */
      only?: string[]
      /** Paths in each skill directory to leave out, gitignore-style. */
      exclude?: string[]
    }
  | {
      source: 'inline'
      /** The skill's name, as in `SKILL.md`'s frontmatter. */
      name: string
      /** The skill's description, as in `SKILL.md`'s frontmatter. */
      description: string
      /** The body of `SKILL.md`. */
      content: string
      /** Other files in the skill directory, by relative path. */
      files: Record<string, string>
    }
)

/** A `docker({ install })` command, baked into a cached image layer: no secrets, root, cwd `/`. */
export type InstallStep =
  | string
  | {
      /** The shell command. */
      run: string
      timeout?: Duration
    }
/**
 * Runs in every attempt before the agent starts, with secrets, outside the eval timeout: a shell
 * command, or `{ run, timeout?, cwd? }`.
 */
export type SetupStep =
  | string
  | {
      /** The shell command. */
      run: string
      /** Default 5m. */
      timeout?: Duration
      /** Relative to the workspace, or absolute; default the workspace. */
      cwd?: string
    }

/**
 * Where the sandbox may connect: any host over HTTP(S) through the egress gateway (`'proxy'`, the
 * default), anywhere including raw TCP and UDP around the gateway (`'allow-all'`), nowhere
 * (`'deny-all'`), or only the listed hosts (`'*.example.com'` matches subdomains). Under a
 * restricted policy the harness's own hosts, brokered secrets' `hosts` and MCP servers' hosts are
 * allowed too; any other request gets a refusal, and the attempt goes on.
 */
export type EgressPolicy = 'proxy' | 'allow-all' | 'deny-all' | { allow: readonly string[] }

/**
 * A git repository (or one directory of it) the workspace starts as, from the `git` helper. `url`
 * is what reeval fetches: the clone URL, or an absolute path for a local repository.
 */
export type GitWorkspace = {
  kind: 'git'
  /** As written: a URL, `github:owner/repo`, or a local path. */
  repo: string
  /** What reeval fetches: the clone URL, or an absolute path for a local repository. */
  url: string
  /** A branch, tag or commit SHA; unset is the remote's `HEAD`. */
  ref?: string
  /** A directory in the repository whose contents become the workspace. */
  path?: string
  /** Give the workspace a `.git`: one commit of the fetched tree, with no remote. */
  init?: boolean
  /** The host variable holding a token for the fetch; read on the host only. */
  token?: string
}

export type GitHelper = (
  repo: string | URL,
  options?: { ref?: string; path?: string; init?: boolean; token?: string },
) => GitWorkspace

/** What an eval runs in: the declarative, phased spec of one environment. */
export type EnvironmentSpec = {
  /**
   * Where the attempt runs: `docker()` or `fakeSandbox()`. A child's `extend` / `extendEnvironment`
   * replaces the parent's entirely when it sets one; install is not merged onto the parent image.
   */
  sandbox?: SandboxDescriptor
  /** The code the workspace starts as, before `files`, `rules` and `setup`; a child's replaces its parent's. */
  workspace?: GitWorkspace
  /** Variables and secrets for the sandbox, merged by name over the parent's. */
  env?: EnvVars
  /** Replaces the inherited policy; an `extend` child's replaces its parent's. */
  egress?: EgressPolicy
  /** Workspace-relative, or `~/` for home. */
  files?: Record<string, string | HostFile>
  /** Project rules, written where the harness's agent reads them: `AGENTS.md`, or `CLAUDE.md` for Claude Code. */
  rules?: string | HostFile
  /** Shell commands run in every attempt before the agent starts; a child's run after its parent's. */
  setup?: SetupStep[]
  /** Skills placed for the agent. */
  skills?: SkillSource[]
  /** MCP servers the agent gets, by name. */
  mcp?: Record<string, McpServer>
  /**
   * Plugins in Claude Code's layout, made by the `plugin` helper; a child's replaces its
   * parent's plugin of the same name.
   */
  plugins?: PluginSource[]
}

/**
 * A part of a plugin, as Claude Code's layout bundles it: `skills/<name>/SKILL.md`,
 * `agents/<name>.md`, `commands/<name>.md`, `hooks/hooks.json`, `.mcp.json` (or the manifest's `mcpServers`) or `rules/`.
 */
export type PluginPart = 'skills' | 'agents' | 'commands' | 'hooks' | 'mcp' | 'rules'

/** A plugin to place for the agent, in Claude Code's layout, made by the `plugin` helper. */
export type PluginSource = {
  kind: 'plugin'
  /** The parts to place; default every part the plugin has. */
  only?: PluginPart[]
  /** Commands that build the plugin in a Docker image layer, from its directory unless `cwd` says otherwise. */
  build?: PluginBuild
} & (
  | {
      source: 'local'
      /** A host directory with a `.claude-plugin/plugin.json`. */
      path: string
    }
  | {
      source: 'git'
      /** As written: a URL, `github:owner/repo`, or a GitHub `/tree/<ref>/<path>` URL. */
      repo: string
      /** A branch, tag or commit SHA; unset is the remote's `HEAD`. */
      ref?: string
      /** The plugin's directory in the repository; default its root. */
      path?: string
    }
  | {
      source: 'npm'
      /** A pinned npm package spec. */
      spec: string
      /** The plugin's directory in the package; default its root. */
      path?: string
    }
  | {
      source: 'marketplace'
      /** The plugin's entry in the marketplace's `.claude-plugin/marketplace.json`. */
      name: string
      /** Where the marketplace is: a git repository (at `ref`) or an npm package. */
      marketplace: PluginMarketplace
    }
)

/** A Claude Code marketplace: the source that holds its `.claude-plugin/marketplace.json`. */
export type PluginMarketplace =
  | {
      source: 'git'
      /** As written: a URL or `github:owner/repo`. */
      repo: string
      /** A branch, tag or commit SHA; unset is the remote's `HEAD`. */
      ref?: string
    }
  | {
      source: 'npm'
      /** An npm package spec. */
      spec: string
    }

/**
 * Shell commands that build a plugin in a Docker image layer, on the cell's harness image, as root
 * and with no secrets: one, a list, or `{ run, cwd }`. They run from the plugin's directory, or from
 * `cwd`, relative to the source's root (`'.'` for the repository's or package's root).
 */
export type PluginBuild =
  | string
  | string[]
  | {
      /** The command, or the commands in order. */
      run: string | string[]
      /** Where they run, relative to the source's root; default the plugin's directory. */
      cwd?: string
    }

type PluginOptions = {
  /** The parts to place, e.g. `['skills', 'mcp']`; default every part the plugin has. */
  only?: readonly PluginPart[]
  /**
   * Commands that build the plugin in a Docker image layer, e.g. `'npm ci && npm run build'`, or
   * `{ run, cwd: '.' }` to run them from the source's root. Only the plugin's directory is placed.
   */
  build?: string | readonly string[] | { run: string | readonly string[]; cwd?: string }
}

export type PluginHelper = {
  /** A directory with a `.claude-plugin/plugin.json`, relative to the calling file. */
  local(path: string | URL, options?: PluginOptions): PluginSource
  /** `https://…`, `git@…`, `github:owner/repo` or a GitHub `/tree/<ref>/<path>` URL. */
  git(repo: string, options?: PluginOptions & { ref?: string; path?: string }): PluginSource
  /** A pinned npm package spec; the plugin is at `path` inside it (default its root). */
  npm(spec: string, options?: PluginOptions & { path?: string }): PluginSource
  /**
   * `'name@source'`: the entry `name` in a Claude Code marketplace, at a git repository (a URL or
   * `github:owner/repo`, at `ref`) or an npm package (`npm:<spec>`).
   */
  marketplace(entry: string, options?: PluginOptions & { ref?: string }): PluginSource
}

/** One environment in an `extend` chain. */
export type EnvironmentLayer = {
  /** The name passed to `defineEnvironment` or `extend`. */
  name: string
  /** The spec as that layer wrote it, before merging. */
  spec: EnvironmentSpec
}

/**
 * What an eval runs in: the sandbox, skills, MCP servers, files, rules, variables, secrets and
 * setup. Plain data (`layers` root first), plus non-enumerable `extend` / `extendEnvironment`.
 */
export type Environment = {
  readonly kind: 'environment'
  /** The name it was defined or extended under, which names its cells. */
  readonly name: string
  /** Its `extend` chain, root first. */
  readonly layers: readonly EnvironmentLayer[]
  /**
   * A child environment layered on this one; wherever it sets a key this one has, it wins.
   * `sandbox` is replaced entirely when the child sets one; when the child omits it, the
   * parent's sandbox is kept. This is how two `compare` arms share setup: `compare` itself
   * never layers.
   */
  extendEnvironment(name: string, spec: EnvironmentInput): Environment
  /** Alias of `extendEnvironment`. */
  extend(name: string, spec: EnvironmentInput): Environment
}

/** Typed helpers for environment specs, passed to `defineEnvironment` and `extend` callbacks. */
export type EnvironmentHelpers = {
  secret: SecretHelper
  skill: SkillHelper
  mcp: McpHelper
  plugin: PluginHelper
  /** A host file, relative to the file that calls it (or an absolute path or `URL`). */
  file: (path: string | URL) => HostFile
  /**
   * Every file in a host directory, as `files` entries: workspace-relative paths mapped to the
   * same sources `file()` returns, so spreading and overriding work. Walked when it's called.
   */
  directory: (path: string | URL, options?: DirectoryOptions) => Record<string, HostFile>
  /** A git repository for `workspace`: a URL, `github:owner/repo`, or a local path. */
  git: GitHelper
}

export type SecretHelper = {
  /** The host variable of the same name as the key it's set under. */
  (options?: SecretOptions): Secret
  fromEnv(host: string, options?: SecretOptions): Secret
  template(template: string): SecretTemplate
  /** The hosts well-known APIs take their keys on, for `hosts`. */
  hosts: {
    readonly gemini: readonly string[]
    readonly openai: readonly string[]
    readonly anthropic: readonly string[]
    readonly github: readonly string[]
  }
}

type SkillCommon = { placement?: SkillPlacement }
type SkillDirOptions = SkillCommon & {
  only?: string[]
  /**
   * Paths in each skill directory to leave out of the sandbox, gitignore-style: `*` matches within
   * a name, a leading or inner `/` anchors to the skill root, a trailing `/` matches directories
   * only, and anything else matches a name at any depth. Replaces `DEFAULT_SKILL_EXCLUDE`
   * (`/evals/`, `.history/`, `*.eval.ts`); spread it to add to it. `.git` is always left out.
   */
  exclude?: readonly string[]
}
export type SkillHelper = {
  /** A directory with a `SKILL.md`, or a directory of them, relative to the calling file. */
  local(path: string | URL, options?: SkillDirOptions): SkillSource
  /** `https://…`, `git@…`, `github:owner/repo` or a GitHub `/tree/<ref>/<path>` URL. */
  git(repo: string, options?: SkillDirOptions & { ref?: string; path?: string }): SkillSource
  /** A skills.sh id, `owner/repo@skill`; `version` is a git ref. */
  registry(id: string, options?: SkillCommon & { version?: string }): SkillSource
  /** A pinned npm package spec; skills are read from `path` inside it (default `skills`). */
  npm(spec: string, options?: SkillDirOptions & { path?: string }): SkillSource
  inline(
    skill: { name: string; description: string; content: string; files?: Record<string, string> },
    options?: SkillCommon,
  ): SkillSource
}

export type McpHelper = {
  stdio(command: string, args?: string[], options?: { env?: EnvVars }): McpServer
  http(
    url: string,
    options?: { headers?: Record<string, string | Secret | SecretTemplate> },
  ): McpServer
  sse(
    url: string,
    options?: { headers?: Record<string, string | Secret | SecretTemplate> },
  ): McpServer
}

/** A spec, or a callback that gets the typed helpers and returns one (synchronously). */
export type EnvironmentInput = EnvironmentSpec | ((helpers: EnvironmentHelpers) => EnvironmentSpec)

/**
 * An edit of the inherited harness list, as data: `add` appends harnesses, `only` keeps the
 * inherited ones with these ids, in their order.
 */
export type HarnessEdit =
  | { add: HarnessDescriptor | HarnessDescriptor[] }
  | { only: string | string[] }

/** One value, a list (each is its own cell), or an edit of the inherited list, as data. */
export type HarnessData = HarnessDescriptor | HarnessDescriptor[] | HarnessEdit

/** `HarnessData`, or a function that edits the inherited list (TypeScript only). */
export type HarnessOption =
  | HarnessData
  | ((inherited: HarnessDescriptor[]) => HarnessDescriptor | HarnessDescriptor[])

export type CompareGate = 'variants' | 'all' | 'none'

/**
 * The baseline and each variant run as their own environments, with the same prompt and checks.
 * `compare` does not layer them. Share setup first with `environment.extend` / `extendEnvironment`.
 * `false` is not a value here: a profile turns compare off with `limit.compare`.
 */
export type CompareOptions<E = Environment> = {
  /**
   * The control. Not layered under the variants. Without it, the control is the environment the
   * eval would otherwise run in (the cascaded `environment`), else an empty one named `baseline`.
   */
  baseline?: E
  /** Other environments, each planned and run as itself. */
  variants: E[]
  /** Which cells decide pass/fail: `variants` (default), `all`, or `none` (report only). */
  gate?: CompareGate
  /** Lift in points from -1 to 1; a variant cell below it fails. */
  minLift?: number
  /** Harnesses (ids or descriptors) to compare on; the others run the control only. */
  harness?: Array<string | HarnessDescriptor>
}

/**
 * A question a language model answers after the attempts: its text, or the text and its options.
 * With `across`, it picks between two attempts that differ only in that factor, in both orders;
 * without it, it's asked of each attempt on its own. Without a model, the cascaded
 * `question.model` answers, else `analysis.model`, else the judge's when it's a language model.
 * `state` and `artifacts` choose what it's shown of each attempt.
 */
export type Question =
  | string
  | {
      question: string
      /** `'provider/model'` that answers it, over the cascaded `question.model`. */
      model?: string
      /**
       * The factor it varies when pairing, or both: `'environment'` holds the harness,
       * `'harness'` holds the environment. Unset, it's asked of each attempt on its own.
       */
      across?: PairFactor | PairFactor[]
      /** The answers a question asked of each attempt picks from, with a short reason. */
      choices?: string[]
      /** What it's shown of each attempt, over the cascaded `question.state`, key by key. */
      state?: QuestionStateOptions
      /** Each attempt's own captures, by name; `true` sends all of them. Replaces `question.artifacts`. */
      artifacts?: true | string[]
    }

/**
 * What a question is shown of each attempt: the keys of `judge.state` but `contents` (the
 * attempts' workspaces are gone when questions are asked). An unset key keeps its default: a
 * pairwise question shows the task and the diff; one asked of each attempt also shows the final
 * message and the transcript.
 */
export type QuestionStateOptions = {
  /** The prompts the attempt was sent, once for both sides when they match. Default true. */
  task?: boolean
  /** The final message: the agent's own account of its work. Default false in a pair, true per attempt. */
  output?: boolean
  /** `status path` lines for the changed files, under `diff`'s patterns. Default false. */
  files?: boolean
  /**
   * The diff since the eval started. A list is gitignore-style patterns over workspace paths:
   * the last matching pattern wins and `!` excludes. Default true.
   */
  diff?: boolean | string[]
  /**
   * The transcript as text lines: `true` is messages and tool calls with tool output clipped,
   * `'tools'` tool calls only, `'full'` adds reasoning and whole tool output. It names each
   * harness's tools, so a pair of two harnesses isn't blind. Default false in a pair, true per
   * attempt.
   */
  transcript?: boolean | 'tools' | 'full'
  /**
   * `'all'`: every turn under `turns`, each with its task, output and (with `transcript`)
   * transcript; `'last'`: the last turn only. Default `'all'`.
   */
  turns?: 'last' | 'all'
  /** `c.exec` results; a list shows only those commands, as passed to `c.exec`. Default false. */
  checks?: boolean | string[]
}

/** `QuestionStateOptions` with every key set: what each side of one question showed. */
export type ResolvedQuestionStateOptions = {
  task: boolean
  output: boolean
  files: boolean
  diff: boolean | string[]
  transcript: boolean | 'tools' | 'full'
  turns: 'last' | 'all'
  checks: boolean | string[]
}

/** Defaults for every question: `model` and `artifacts` replaced, `state` merged key by key. */
export type QuestionOptions = {
  /** `'provider/model'` that answers every question below it without its own `model`. */
  model?: string
  /** What it's shown of each attempt. */
  state?: QuestionStateOptions
  /** Each attempt's own captures, by name; `true` sends all of them. Default none. */
  artifacts?: true | string[]
}

/**
 * A question as planned: its text, the model it names itself, if any, the factors it varies when
 * it's pairwise, its choices, and what it's shown of each attempt, cascaded, when set.
 */
export type PlannedQuestion = {
  /** Its place in the eval's `questions`, from 1, kept when a profile drops one before it. */
  n: number
  question: string
  model?: string
  /** Set on a pairwise question; unset, it's asked of each attempt. */
  across?: PairFactor | PairFactor[]
  choices?: string[]
  state?: QuestionStateOptions
  artifacts?: true | string[]
}

/** A matrix factor a pairwise question varies; the others are held. */
export type PairFactor = 'environment' | 'harness'

/** Which pairs a vote is over: two environments on one harness, or two harnesses on one environment. */
export type CompareCut = 'within' | 'across'

/** One judgement of one pair of attempts, in one order. */
export type PairVote = {
  question: string
  cut: CompareCut
  /** Set on a within-harness pair: the harness both arms ran on. */
  harness?: string
  /** Set on a cross-harness pair: the arm (environment) both harnesses ran. */
  arm?: string
  /** The run number both attempts share, from 1. */
  run: number
  /** The two sides by name: arms within a harness, harness ids across. */
  a: string
  b: string
  /** `a`, `b` or `'tie'`, mapped back from the blinded labels. */
  winner: string | 'tie'
  /** True for the repeat that showed `b` first. */
  swapped: boolean
  /** The model's short reason for this pick; omitted when it gave none. Capped. */
  reason?: string
  /** The captures each named side showed, by name; set when the question sends `artifacts`. */
  artifacts?: { a: string[]; b: string[] }
}

/** A pairwise question's answer: every vote, and each side's wins over decided votes per cut. */
export type CompareAnswer = {
  question: string
  /** `'provider/model'`, or `fake` for `fakeAnalysis()`. */
  model: string
  /** The model id the provider says served the calls, when it reports one. */
  resolvedModel?: string
  /** What each side showed, every key resolved; unset on answers from before questions took `state`, which showed the defaults. */
  stateOptions?: ResolvedQuestionStateOptions
  /** The captures it sent of each side, as asked: `true` for all, or their names. */
  artifacts?: true | string[]
  votes: PairVote[]
  /** Wins over decided pairs, per named side, per cut. */
  rates: Array<{ cut: CompareCut; name: string; wins: number; n: number }>
  /** Why some or all of its votes are missing: the model call failed. Outcomes never change. */
  error?: string
  /** `questions/<n>.json` under the eval's directory: what the model was sent, per pair and order. */
  input?: FileRef
}

/** A screenshot a question sent: its label, and the capture it was; refs only, never the bytes. */
export type QuestionScreenshot =
  | {
      label: string
      /** The named side it came from. */
      side: string
      name: string
      /** The capture under the run directory; unset when the run kept no artifacts for it. */
      path?: string
    }
  | { label: string; missing: true }

/** One order of one pair as the model was asked it. */
export type QuestionCall = {
  cut: CompareCut
  harness?: string
  arm?: string
  run: number
  /** The two sides by name, as on the votes. */
  a: string
  b: string
  /** True for the repeat that showed `b` first. */
  swapped: boolean
  /** Which named side the model saw as A and as B. */
  labels: { A: string; B: string }
  system: string
  /** The prompt as sent, secrets masked; screenshots follow it as image parts. */
  prompt: string
  screenshots?: QuestionScreenshot[]
  /** Set when this call failed. */
  error?: string
}

/** `questions/<n>.json`: every call one pairwise question made, in pair order. */
export type QuestionInput = {
  question: string
  model: string
  stateOptions: ResolvedQuestionStateOptions
  artifacts?: true | string[]
  calls: QuestionCall[]
}

/** A question asked of one attempt on its own, and the model's answer. Never gates. */
export type AttemptAnswer = {
  question: string
  /** `'provider/model'`, or `fake` for `fakeAnalysis()`. */
  model: string
  /** The model id the provider says served the call, when it reports one. */
  resolvedModel?: string
  /** What the attempt showed, every key resolved. */
  stateOptions: ResolvedQuestionStateOptions
  /** The captures it sent, as asked: `true` for all, or their names. */
  artifacts?: true | string[]
  /** The answers it picked from; unset on a free-text question. */
  choices?: string[]
  /** One of `choices`; unset on a free-text question and when the call failed. */
  choice?: string
  /** The model's answer, or its reason for `choice`; capped, and empty when the call failed. */
  text: string
  /** Why there's no answer: the model call failed. Outcomes never change. */
  error?: string
  /** `questions/<n>.json` under the attempt's directory: what the model was sent. */
  input?: FileRef
}

/** An attempt's `questions/<n>.json`: the call a question asked of it made. */
export type AttemptQuestionInput = {
  question: string
  model: string
  stateOptions: ResolvedQuestionStateOptions
  artifacts?: true | string[]
  choices?: string[]
  system: string
  /** The prompt as sent, secrets masked; screenshots follow it as image parts. */
  prompt: string
  screenshots?: QuestionScreenshot[]
  /** Set when the call failed. */
  error?: string
}

/** An option a profile's `limit` can narrow, and `pin` can protect. */
export type PinnableKey = 'harness' | 'runs' | 'compare'

/**
 * How a cell's attempts decide its outcome: `'all'` (the default) passes only when every attempt
 * passes (pass^k); `{ passRate }` passes when its pass@1 (passes over passes and fails) is at
 * least that share.
 */
export type GatePolicy = 'all' | { passRate: number }

/** A cell's gate: its policy, or `'none'` when its failures don't fail the eval (a control's). */
export type CellGate = GatePolicy | 'none'

/** A compare object: `baseline` and `variants`. Same as `CompareOptions`. */
export type CompareSpec<E = Environment> = CompareOptions<E>

/** Options other than `environment` and `compare`, which are exclusive of each other. */
type EvalOptionFields = {
  /** Which agents run the eval; each harness is its own cell. */
  harness?: HarnessOption
  /**
   * The default machine when the resolved environment omits `sandbox`. Cascades like `harness`.
   * Not an environment: it does not invent skills, files or a name.
   */
  sandbox?: SandboxDescriptor
  /** Attempts per cell. */
  runs?: number
  /** How each cell's attempts decide its outcome; default `'all'`. */
  gate?: GatePolicy
  /** Variables and secrets for the sandbox, merged by name down the cascade. */
  env?: EnvVars
  /**
   * Where the sandbox may connect. Replaces the inherited policy: config, profile defaults, the
   * environment, then groups and the eval.
   */
  egress?: EgressPolicy
  /** Defaults for `c.judge()`, merged field by field down the cascade. */
  judge?: JudgeOptions
  /** Screenshot defaults for `c.capture()`. Shallow-merged; `viewport` and `model` replace the value. */
  capture?: CaptureOptions
  /** Defaults for every question: `model`, and `state` merged key by key, down the cascade. */
  question?: QuestionOptions
  /**
   * What a language model is asked about the attempts, always a list; they never change pass,
   * fail or the exit code. A question with `across` picks between pairs of attempts once they all
   * end; one without is asked of each attempt as it ends. Replaces the inherited list, so `[]`
   * asks none.
   */
  questions?: Question[]
  /** Per attempt. */
  timeout?: Duration
  /** Labels for `--tag` and profiles to select by; a group's are added to its evals'. */
  tags?: string[]
  /**
   * The eval's version, part of its fingerprint: bump it when a change the eval file doesn't show
   * (a helper, a fixture, data it reads) changes what it measures. A group's applies to the evals
   * inside it that set none.
   */
  revision?: Revision
  /** Keys a profile's `limit` may not narrow for this group or eval. */
  pin?: PinnableKey[]
}

/** An eval's `revision`: a whole number or a non-empty string, compared exactly. */
export type Revision = number | string

/**
 * An eval's own source as hashes: its body and case data as declared, and its options and its
 * enclosing groups' in canonical form (`tags`, `revision` and `gate` aside).
 */
export type EvalSource = DeclaredSource & {
  /** sha256 of the canonical options. */
  options: string
}

/**
 * `compare: false` is not an option here: a profile's `limit.compare: false` strips variants.
 * A compare with a `baseline` names every arm, so the cascaded `environment` is not applied, and
 * the same object can't set both. Without a `baseline`, the cascaded `environment` (this object's
 * own, or an inherited one) is the control.
 */
type EnvironmentOrCompare<E> =
  | {
      /** What this group or eval runs in, and the control of a compare without a `baseline`. */
      environment?: E
      compare?: never
    }
  | {
      /** Forbidden beside `compare.baseline`, which names the control. */
      environment?: never
      /** Environments to run side by side; `baseline` is the control. */
      compare: CompareSpec<E> & { baseline: E }
    }
  | {
      /** The control: the compare has no `baseline`. */
      environment?: E
      /** Environments to run side by side against `environment`, the control. */
      compare: CompareSpec<E> & { baseline?: undefined }
    }

export type EvalOptions = EvalOptionFields & EnvironmentOrCompare<Environment>
export type GroupOptions = EvalOptions

/**
 * `EvalOptions` in their data forms, as JSON carries them: the harness as data, the judge's model
 * by name or a fake judge, and environments without `extend`. The same `environment` / compare
 * object split as `EvalOptions`.
 */
export type EvalOptionsData = Omit<EvalOptionFields, 'harness' | 'judge'> & {
  /** Which agents run the eval; each harness is its own cell. */
  harness?: HarnessData
  /** Defaults for `c.judge()`, merged field by field down the cascade. */
  judge?: ConfigJudgeOptions
} & EnvironmentOrCompare<EnvironmentData>

/** An `Environment` as data, as JSON carries it: without `extend` / `extendEnvironment`. */
export type EnvironmentData = Omit<Environment, 'extendEnvironment' | 'extend'>

/** The config file is plain data sent to workers, so its judge model can't be an object. */
export type ConfigJudgeOptions = Omit<JudgeOptions, 'model'> & {
  /** `'provider/model'`, or a fake judge. */
  model?: string | FakeJudgeModel
}

export type HistoryConfig = {
  /** Committed history folder (default: `.history` in the directory the evals live in). */
  dir?: string
  /** Artifacts recorded next to each run: every attempt's, failed attempts' only, or none. */
  artifacts?: ArtifactLevel
}

/** Run-level caps. `attempts` is checked against the plan; `duration` while running. */
export type Budget = {
  /** The most attempts the plan may have. */
  attempts?: number
  /** How long the run may go on, from the first attempt's start. */
  duration?: Duration
}

/** What evals get when they don't say otherwise: under groups and evals. */
export type ProfileDefaults = {
  /** The agents every eval runs on, unless a group or eval replaces them. */
  harness?: HarnessDescriptor | HarnessDescriptor[]
  /** The default machine when the resolved environment omits `sandbox`. */
  sandbox?: SandboxDescriptor
  /** What every eval runs in when it names no environment. */
  environment?: Environment
  /** Attempts per cell. */
  runs?: number
  /** How each cell's attempts decide its outcome. */
  gate?: GatePolicy
  /** Variables and secrets for the sandbox, merged by name over the config's. */
  env?: EnvVars
  /** Where the sandbox may connect; replaces the config's policy. */
  egress?: EgressPolicy
  /** Defaults for `c.judge()`, merged field by field over the config's. */
  judge?: ConfigJudgeOptions
  /** Per attempt. */
  timeout?: Duration
  /** Screenshot defaults for `c.capture()`, shallow-merged over the config's. */
  capture?: CaptureOptions
  /** Defaults for every question, merged over the config's. */
  question?: QuestionOptions
}

/** Over every eval, and it can only narrow; `pin` on a group or eval skips it. */
export type ProfileLimit = {
  /** The most runs per cell. */
  runs?: number
  /** `false` runs the control only; `{ maxVariants }` keeps the first n variants. */
  compare?: false | { maxVariants: number }
  /** Harness ids to allow; evals left with none are skipped. */
  harness?: string[]
}

/** How a run is sized: chosen with `--profile`, `REEVAL_PROFILE` or `defaultProfile`. */
export type Profile = {
  /** What evals get when they don't say otherwise: under groups and evals. */
  defaults?: ProfileDefaults
  /** Caps over every eval, which only narrow; `pin` on a group or eval skips them. */
  limit?: ProfileLimit
  /** Judge settings for this profile, the same as `defaults.judge`, which wins field by field. */
  judge?: ConfigJudgeOptions
  /** Merged over the config's `budget`. */
  budget?: Budget
  /** When this profile's runs are copied into the history folder. */
  record?: RecordMode
  /** Tag filters for this profile, like `--tag` (`'!slow'` excludes). */
  tags?: string[]
  /** Replaces the config's `gateway` list for this profile's runs. */
  gateway?: GatewayDescriptor[]
}

/** A canned analysis for tests; see `fakeAnalysis()` in `reeval/judge`. */
export type FakeAnalysisModel = {
  kind: 'fake-analysis'
  /** The model's structured answer, or a function of the digest it was given. */
  output?: unknown | ((digest: unknown) => unknown)
  /**
   * How it answers pairwise questions: a fixed pick, a function of the blinded pair, or
   * `{ error }` to fail every call. A pick may be `{ winner, reason? }`. Default `'tie'`.
   */
  vote?: FakePick | ((pair: BlindPair) => FakePick) | { error: string }
  /**
   * How it answers questions asked of each attempt: a fixed answer, a function of the attempt as
   * the model sees it, or `{ error }` to fail every call. An answer may be `{ choice?, text? }`.
   * Default the first of the question's `choices`, with the text `fake answer`.
   */
  answer?: FakeAnswer | ((attempt: BlindAttempt) => FakeAnswer) | { error: string }
}

/** A blinded label's pick: the attempt shown first (`A`), second (`B`), or neither. */
export type FakeVote = 'A' | 'B' | 'tie'

/** A fake pairwise pick, optionally with a reason. */
export type FakePick = FakeVote | { winner: FakeVote; reason?: string }

/** A fake per-attempt answer: its text, or a choice and its reason. */
export type FakeAnswer = string | { choice?: string; text?: string }

/** What a pairwise question's model is shown: the prompt, and the two sides in slot order. */
export type BlindPair = { question: string; prompt: string; a: BlindSide; b: BlindSide }

/** What a per-attempt question's model is shown: the prompt, its choices, and the attempt. */
export type BlindAttempt = {
  question: string
  prompt: string
  choices?: string[]
  attempt: BlindSide
}

/** A turn of one side, with the keys its question's `state` turned on. */
export type BlindTurn = { task?: string; output?: string; transcript?: string }

/**
 * One side of a blinded pair, or the attempt a per-attempt question is asked of: only the keys
 * its question's `state` turned on. With `turns: 'all'`, `task`, `output` and `transcript` are
 * under `turns`; a task both sides of a pair share is the pair's prompt's, not either side's.
 */
export type BlindSide = BlindTurn & {
  turns?: BlindTurn[]
  files?: string[]
  /** The diff as the model sees it: dependency and binary noise dropped. */
  diff?: string
  /** A command the other side ran and this one didn't is `{ command, notRun: true }`. */
  checks?: Array<
    | { command: string; exitCode: number; stdout: string; stderr: string }
    | {
        command: string
        notRun: true
      }
  >
  /** Its captures, in the order sent, labelled by position; a name it lacks is `missing`. */
  artifacts?: Array<
    { label: string; mediaType: 'image/png'; bytes: number } | { label: string; missing: true }
  >
}

/** `reeval analyze`: a language model (not an evaluation model) and what matters in this project. */
export type AnalysisConfig = {
  /**
   * `'provider/model'`, e.g. `'google/gemini-3.8-flash'`. Unset, `reeval analyze` and questions
   * fall back to the judge's when it's a language model.
   */
  model?: string | FakeAnalysisModel
  /** Added to the prompt, e.g. "Fewer tool calls count as a win. The skill under test is reeval-good." */
  instructions?: string
  /** The digest's cap; evidence is dropped, lowest priority first, to fit (default 20000). */
  maxInputTokens?: number
  /** The most tokens the model may answer with (default 8000). reeval has no prices, so tokens are the cap. */
  maxOutputTokens?: number
}

export type ReevalConfig = {
  /** Globs of eval files, relative to the config's directory; default every `.eval.ts` under `evals`. */
  include?: string[]
  /** The agents every eval runs on, unless a group or eval replaces them; default Cursor. */
  harness?: HarnessDescriptor | HarnessDescriptor[]
  /**
   * The default machine when the resolved environment omits `sandbox`. Not an environment:
   * it does not invent skills, files or a name. Implicit `docker()` when nobody sets one.
   */
  sandbox?: SandboxDescriptor
  /** What every eval runs in when it names no environment, and a baseline-less compare's control. */
  environment?: Environment
  /** Attempts per cell; default 1. */
  runs?: number
  /** How each cell's attempts decide its outcome; default `'all'`. */
  gate?: GatePolicy
  /** Variables and secrets for the sandbox, merged by name down the cascade. */
  env?: EnvVars
  /** Where the sandbox may connect; default `'proxy'`. */
  egress?: EgressPolicy
  /** Defaults for `c.judge()`, merged field by field down the cascade. */
  judge?: ConfigJudgeOptions
  /** Per attempt; default `'15m'`. */
  timeout?: Duration
  /**
   * Screenshot defaults for `c.capture()`. `REEVAL_CAPTURE_BROWSER=0` refuses the host
   * binary when `c.capture()` runs; it does not change this object.
   */
  capture?: CaptureOptions
  /** Defaults for every question: the model that answers it and what it's shown of each attempt. Merged down the cascade. */
  question?: QuestionOptions
  /** How many attempts run at once. `--concurrency` and `REEVAL_CONCURRENCY` override it. */
  concurrency?: number
  /** When runs are copied into the history folder: `reeval record` only, in CI, or on every run. */
  record?: RecordMode
  /** The history folder, and which attempts keep their artifacts there. */
  history?: HistoryConfig
  /** Caps on a run; a profile's `budget` is merged over it. */
  budget?: Budget
  /** Named presets of `defaults`, `limit`, `judge`, `budget`, `record` and `tags`. */
  profiles?: Record<string, Profile>
  /** The profile when neither `--profile` nor `REEVAL_PROFILE` names one: `ci` when `CI` is set. */
  defaultProfile?: { ci?: string; local?: string }
  /** `unbrokered: 'error'` refuses Docker secrets without `hosts`, and credential-like MCP headers written as plain strings, instead of warning (default `'warn'`). */
  secrets?: { unbrokered?: 'warn' | 'error' }
  /**
   * Local debug data in `.reeval/debug`: how many runs to keep (default 20), and how many MB of raw
   * trace each attempt buffers for trace.ndjson (default 8; the oldest entries go first).
   */
  debug?: { keep?: number; traceBufferMb?: number }
  /** `reeval analyze`, and questions without a model of their own. */
  analysis?: AnalysisConfig
  /**
   * The gateways model calls may go through, in the order you prefer them: each harness takes
   * the first that can serve it. Default `[direct()]`, each provider's own key.
   */
  gateway?: GatewayDescriptor[]
}

/** `fakeJudge()` as data: the score every call gets. */
export type FakeJudgeData = {
  kind: 'fake-judge'
  /** The score (0–1) every call gets. */
  score: number
}

/** `ConfigJudgeOptions` as data: the model by name, or a fake judge with a fixed score. */
export type ConfigJudgeData = Omit<ConfigJudgeOptions, 'model'> & {
  /** `'provider/model'`, or a fake judge. */
  model?: string | FakeJudgeData
}

/** `fakeAnalysis()` as data: canned answers, without the functions of the digest or pair. */
export type FakeAnalysisData = {
  kind: 'fake-analysis'
  /** The model's structured answer. */
  output?: unknown
  /** How it answers pairwise questions: a fixed pick, or `{ error }` to fail every call. */
  vote?: FakePick | { error: string }
  /** How it answers questions asked of each attempt: a fixed answer, or `{ error }` to fail every call. */
  answer?: FakeAnswer | { error: string }
}

/** `AnalysisConfig` as data: the model by name, or a fake analysis. */
export type AnalysisConfigData = Omit<AnalysisConfig, 'model'> & {
  /**
   * `'provider/model'`, e.g. `'google/gemini-3.8-flash'`. Unset, `reeval analyze` and questions
   * fall back to the judge's when it's a language model.
   */
  model?: string | FakeAnalysisData
}

/** `ProfileDefaults` as data: the environment without `extend`, and the judge as data. */
export type ProfileDefaultsData = Omit<ProfileDefaults, 'environment' | 'judge'> & {
  /** What every eval runs in when it names no environment. */
  environment?: EnvironmentData
  /** Defaults for `c.judge()`, merged field by field over the config's. */
  judge?: ConfigJudgeData
}

/** `Profile` as data: its defaults and judge as data. */
export type ProfileData = Omit<Profile, 'defaults' | 'judge' | 'gateway'> & {
  /** What evals get when they don't say otherwise: under groups and evals. */
  defaults?: ProfileDefaultsData
  /** Judge settings for this profile, the same as `defaults.judge`, which wins field by field. */
  judge?: ConfigJudgeData
  /** Replaces the config's `gateway` list for this profile's runs. */
  gateway?: GatewayEntryData[]
}

/**
 * `ReevalConfig` in its data forms, as `reeval.yaml` or another language carries it: the
 * environment without `extend`, judge and analysis models by name or as fakes with fixed answers,
 * and profiles the same way. AI SDK model objects and fake score functions are TypeScript only.
 */
export type ReevalConfigData = Omit<
  ReevalConfig,
  'environment' | 'judge' | 'profiles' | 'analysis' | 'gateway'
> & {
  /** What every eval runs in when it names no environment, and a baseline-less compare's control. */
  environment?: EnvironmentData
  /** Defaults for `c.judge()`, merged field by field down the cascade. */
  judge?: ConfigJudgeData
  /** Named presets of `defaults`, `limit`, `judge`, `budget`, `record` and `tags`. */
  profiles?: Record<string, ProfileData>
  /** `reeval analyze`, and questions without a model of their own. */
  analysis?: AnalysisConfigData
  /**
   * The gateways model calls may go through, in the order you prefer them: each harness takes
   * the first that can serve it. Default `[direct]`, each provider's own key.
   */
  gateway?: GatewayEntryData[]
}

/** What a `defineConfig` callback gets: the environment helpers plus the run's context. */
export type ConfigHelpers = EnvironmentHelpers & {
  /** True when `CI` is set and isn't `false`. */
  ci: boolean
  /** The `reeval` command that's running, e.g. `run`. */
  command: string
  /** `process.env`. */
  hostEnv: NodeJS.ProcessEnv
  /** The profile named by `--profile` or `REEVAL_PROFILE` (not `defaultProfile`), else undefined. */
  profile: string | undefined
}

/** A profile as the run uses it, with why it was chosen. */
export type ResolvedProfile = {
  name: string
  /** `--profile`, `REEVAL_PROFILE`, `auto: CI is set` or `default`. */
  reason: string
  defaults: ProfileDefaults
  limit: ProfileLimit
  judge: ConfigJudgeOptions
  tags: string[]
  budget: Budget
  record?: RecordMode
  /** The profile's own `gateway` list, which replaces the config's. */
  gateway?: GatewayDescriptor[]
}

export type ResolvedConfig = {
  root: string
  /** The config file as typed from the current directory, or `reeval.config.ts` without one. */
  file: string
  /** The keys the config sets, for `reeval report`'s config shape. */
  optionKeys?: string[]
  include: string[]
  harness: HarnessDescriptor[]
  /**
   * The default machine when the resolved environment omits `sandbox`. `defineConfig({ sandbox })`
   * sets it; profile defaults, groups and evals cascade over it. Implicit `docker()` when nobody
   * sets one.
   */
  sandbox: SandboxDescriptor
  environment: Environment | undefined
  runs: number
  /** Unset means `'all'`; kept unset so the plan can hint when `runs > 1`. */
  gate: GatePolicy | undefined
  env: EnvVars
  egress?: EgressPolicy
  judge: ConfigJudgeOptions & { threshold: number }
  timeoutMs: number
  capture: CaptureOptions
  question: QuestionOptions
  /** The config's own `concurrency`; see `resolveConcurrency` for the run's. */
  concurrency: number | undefined
  record: RecordMode
  history: { dir: string; artifacts: ArtifactLevel }
  budget: Budget
  profiles: Record<string, Profile>
  defaultProfile: { ci?: string; local?: string }
  secrets: { unbrokered: 'warn' | 'error' }
  debug: { keep: number; traceBufferBytes: number }
  analysis: AnalysisConfig & {
    maxInputTokens: number
    maxOutputTokens: number
  }
  /** The `gateway` list, in preference order; `[direct()]` when the config sets none. */
  gateway: GatewayDescriptor[]
  /** Whether the config sets `gateway`, so the plan shows where each cell resolved. */
  gatewaySet: boolean
}

export type Outcome = 'pass' | 'fail' | 'infra_error' | 'skipped'
export type ErrorKind = 'assertion' | 'timeout' | 'aborted' | 'infra' | 'judge'

/**
 * The sandbox an attempt needed that couldn't be prepared before the run, on each attempt that
 * needed it: its provider's stage (Docker's `image`, `from`, `dockerfile`, `harness` or
 * `install`, or `workspace` for a git workspace, whose `ref` is `repo#ref:path`), what was being
 * made, the class (`config`, `transient` after the retries, or `resource`), a named cause
 * (`enospc`, `oom`), the build log, and the levels that set it.
 */
export type PrepareFailureRecord = {
  class: 'config' | 'transient' | 'resource'
  stage: string
  ref: string | null
  cause: 'enospc' | 'oom' | null
  log: string | null
  setBy: string[]
}

/**
 * The sandbox ran out of a resource during the attempt: `oom` is the kernel killing `kills`
 * processes at its memory limit. The attempt is then an infra error, whatever its checks said.
 */
export type ResourceFailureRecord = { cause: 'oom'; kills: number }

/**
 * Why an attempt failed; `prepare` when its sandbox couldn't be prepared, `resource` when it ran
 * out of one.
 */
export type AttemptError = {
  kind: ErrorKind
  message: string
  prepare?: PrepareFailureRecord
  resource?: ResourceFailureRecord
}

export type TurnRecord = Pick<
  Turn,
  | 'prompt'
  | 'text'
  | 'status'
  | 'transcript'
  | 'startedAt'
  | 'durationMs'
  | 'usage'
  | 'model'
  | 'unreported'
> & {
  raw?: unknown[]
  /** Each stdio MCP server start during the turn; see the run record's `turns[].mcpStartup`. */
  mcpStartup?: McpStartup[]
}

/**
 * One start of a stdio MCP server during a turn (`turns[].mcpStartup`, in start order), timed by
 * reeval's MCP timer, which every stdio server runs through. An agent CLI that runs a process per
 * turn (Antigravity, pi, Codex) starts its servers on every turn; one that keeps a session starts
 * them once, on the first. A server that doesn't answer within 60s fails the attempt as an infra
 * error naming it; one whose client closes it first doesn't. `mcpStartup` is absent when the
 * environment has no stdio MCP server, or the sandbox has no `node` to run the timer.
 */
export type McpStartup = {
  /** The server's name in the environment's `mcp`. */
  server: string
  /**
   * Milliseconds from spawning the server to its answer to the client's `initialize`; null when it
   * never answered (it exited first, timed out, or its client closed it first).
   */
  ms: number | null
}

/** Where an eval's time went, in ms. `agentMs` is the harness turns; `diffMs` reading changes. */
export type PhaseTimings = {
  setupMs: number
  agentMs: number
  diffMs: number
  checksMs: number
  judgeMs: number
}

export type CellRole = 'control' | 'variant'

/**
 * One cell of an eval: a harness, an environment (`-` when none is set) and that environment's
 * image (`sandbox` id: tag, dockerfile and install). With `compare`, the control is `baseline`
 * (or the cascaded environment, or an empty `baseline`) and each variant is that environment on
 * its own, including its sandbox.
 */
export type Cell = {
  key: string
  harness: string
  /** The environment's own name, also on a variant cell (`with-house-greeting`, with no prefix). */
  environment: string
  sandbox: string
  role: CellRole
  /** The variant's name, for variant cells. */
  variant?: string
}

/** A plugin as an attempt placed it. */
export type PluginRecord = {
  /** The manifest's `name`. */
  name: string
  /** Where it came from, e.g. `local:plugins/review`, `github:acme/agent-plugins#v1:plugins/review` or `npm:@acme/review@1.2.0`; for a marketplace entry, the entry's own source. */
  source: string
  /**
   * The marketplace it was listed in, with its `marketplace.json` name, its source as written
   * (`github:acme/agent-plugins#v3`, `npm:@acme/plugins@2.0.0`) and the commit a git one resolved
   * to (null for npm); null when the plugin was named directly.
   */
  marketplace: { name: string; source: string; commit: string | null } | null
  /** The commit a git source resolved to (the marketplace's, for an entry inside it); null for a local or npm one. */
  commit: string | null
  /** The hash of the files placed. */
  sha256: string
  /** The tag of the image layer its build ran in (`reeval-plugin:…`); null without a build. */
  build: string | null
  /** What it placed: skill, agent, command and MCP server names, hook events, and whether it had rules. */
  parts: {
    skills: string[]
    agents: string[]
    commands: string[]
    hooks: string[]
    mcp: string[]
    rules: boolean
  }
}

/** An environment as it was applied, without secret values. */
export type EnvironmentRecord = {
  name: string
  /** The previous `extendEnvironment` layer's name, else null. */
  parent: string | null
  /** Keys a later layer replaced, e.g. `env.KEY`, `skills.genkit`, `mcp.docs`, `rules`. */
  overrides: string[]
  /** Covers every field but the rules file's path; secret names are included, values never are. The image is the sandbox's. */
  digest: string
  setup: string[]
  skills: Array<{
    name: string
    source: string
    commit: string | null
    sha256: string
    placement: SkillPlacement
    /** Paths left out of the sandbox by `exclude` (directories end in `/`); `.git` isn't listed. */
    excluded: string[]
    /** The plugin the skill came with; unset for a skill from `skills`. */
    plugin?: string
  }>
  /** Every MCP server, a plugin's as `<plugin>:<server>`. */
  mcp: string[]
  /** The plugins placed, each with what it placed; in the digest. Unset when there are none. */
  plugins?: PluginRecord[]
  files: Array<{ path: string; sha256: string }>
  vars: string[]
  /**
   * Every secret, by the variable it's set as in the sandbox; an MCP header's (`secret.fromEnv`,
   * `secret.template`, a plugin's `${VAR}`) by each host variable it reads.
   */
  secrets: string[]
  /**
   * Secrets the sandbox only had placeholders for, swapped in by the egress gateway, named as in
   * `secrets`. A variable it also got as its real value somewhere (an `http://` header, an env
   * secret without `hosts`) isn't listed.
   */
  brokered: string[]
  /** Optional secrets whose host variable was unset, so they weren't injected. */
  unset: string[]
  /** The policy the attempt ran under, from the options and the environment; in the digest unless `proxy`. */
  egress: EgressPolicy
  /**
   * The git repository the workspace started as: the repo as written (a local one relative to the
   * project root), the ref and path asked for (null when unset), the commit the ref resolved to
   * and the hash of the tree that was copied in, which is in the digest.
   */
  workspace?: {
    source: string
    ref: string | null
    path: string | null
    commit: string
    tree: string
    /** `init: true`: the workspace had a `.git` with one commit of the tree. */
    init?: boolean
  }
}

/**
 * An attempt's network traffic. `allowed` is every host a restricted policy let through, its own
 * and the automatic ones; null under `proxy` and `allow-all`. `recorded` is false when the sandbox
 * can't see the traffic, and then `contacted` and `blocked` are empty. Bytes are counted between
 * the sandbox and the egress gateway, TLS included. `expectedBlocked` are refused hosts the
 * harness always tries (its CLI's telemetry, say), kept out of `blocked` so a real block stands
 * out.
 */
export type EgressRecord = {
  policy: EgressPolicy
  allowed: string[] | null
  recorded: boolean
  /**
   * True when traffic could leave around the gateway (`allow-all` in a container that kept its
   * network): `contacted` lists only what went through the gateway, and anything that ignored the
   * proxy (raw TCP and UDP, SSH, database drivers) went out unrecorded. Unset otherwise.
   */
  partial?: true
  contacted: Array<{
    host: string
    port: number
    connections: number
    sent: number
    received: number
  }>
  blocked: Array<{ host: string; port: number; connections: number; reason: string }>
  expectedBlocked: Array<{ host: string; port: number; connections: number; reason: string }>
}

/** The image an attempt's container started from, and how reeval made it. */
export type AttemptImage = {
  ref: string
  /** Content-addressed image id (`sha256:…`). */
  id: string
  agentCli: string | null
  /** The harness image `install` and plugin builds were baked onto: `ref` itself without either. */
  base: string
  /** The `docker({ install })` commands, in order. */
  install: string[]
  /** `docker({ dockerfile })`: the path from the project root and the build context's hash. */
  dockerfile: { path: string; sha256: string } | null
  /**
   * `docker({ from })`: the base as written and the digest the image was built on (a local-only
   * base's image id); `reeval image build` rebuilds it when the tag has moved since.
   */
  from?: { ref: string; digest: string | null }
}

/** What one judge call saw, and for a call that failed, why and what was retried first. */
export type JudgeInput = {
  question: string
  model: string
  /** The call's `state` option, every key resolved; `state` is what that gave the judge. */
  stateOptions?: ResolvedJudgeStateOptions
  state: { [key: string]: JSONValue }
  /** Captures sent as file parts; refs only, never the PNG bytes. */
  artifacts?: JudgeArtifactRef[]
  /** What the state leaves out and why, e.g. `dist/ (3 files): build output`. */
  dropped?: string[]
  error?: string
  retries?: JudgeRetry[]
}

/** A harness session start that timed out and was started again. */
export type StartRetry = {
  /** `<harness kind>: session did not become ready within <startTimeout>`. */
  error: string
  /** How long it waited before giving up on that start. */
  waitedMs: number
}

/**
 * A process the setup steps left running in a Docker sandbox with a `to: 'checks'` secret without
 * `hosts` in its environment: it holds the real value while the agent works.
 */
export type SetupProcess = {
  /** Its command line, cut at 200 characters. */
  command: string
  /** The `to: 'checks'` secrets without `hosts` in its environment, by name. */
  secrets: string[]
}

/** One `expect` or `expect.soft` matcher call an attempt made. */
export type AssertionRecord = {
  /**
   * `expect`'s second argument, or `<matcher> <first argument>` (or the command `c.exec` ran, or
   * the judge's question), cut at 60 characters; ` #2`, ` #3` on repeats within the attempt.
   */
  label: string
  /** The eval gave the label. */
  labelled: boolean
  /** `toHaveFile`, `not.toBe`, `resolves.toBe`, `poll.toBe`. */
  matcher: string
  /** `error`: the matcher couldn't answer (a subject it can't read, an event the harness doesn't report). */
  status: 'pass' | 'fail' | 'error'
  soft: boolean
  /** Why it failed or couldn't answer, cut at 1 KB. */
  message?: string
  /** Async matchers only (`toHaveFile`, `toSucceed`, `.resolves`, `expect.poll`). */
  durationMs?: number
}

/** Full per-attempt payload, written to disk by the worker. */
export type EvalRecord = {
  /** When the worker began the attempt (its scheduler lease), for start order across the run. */
  startedAt?: string
  outcome: Exclude<Outcome, 'skipped'>
  error: AttemptError | null
  turns: TurnRecord[]
  /** Workspace changes over the whole eval. */
  diff: Diff | null
  /** Each foreground `c.exec`: its last try's output, and `durationMs` over all its tries. */
  checks: Array<
    { command: string; durationMs: number } & ExecResult & {
        /** The `retries` it was given, when more than 0. */
        retries?: number
        /** Every try, in order, when it was given `retries`. */
        tries?: Array<ExecResult & { durationMs: number }>
      }
  >
  /** Every `expect` and `expect.soft` matcher call that settled, in call order; unset with none. */
  assertions?: AssertionRecord[]
  /**
   * In call order, with `retries` when transient provider errors were retried on the way to the
   * verdict. `call` is the call's place among the attempt's `c.judge()` calls, failed ones
   * included, which its judgement key is numbered by.
   */
  judgements: Array<Verdict & { retries?: JudgeRetry[]; call?: number }>
  /** Session starts that didn't become ready in time and were started again. */
  startRetries?: StartRetry[]
  timings: PhaseTimings
  /** Skills, rules and MCP config visible to the agent, by content hash. */
  context?: Array<{ path: string; sha256: string }>
  /** What each judge call saw, in call order, including calls that errored. */
  judgeInputs?: JudgeInput[]
  environment?: EnvironmentRecord
  image?: AttemptImage | null
  /** Names of the variables and secrets set in the sandbox, and of the brokered secrets among them. */
  env?: { vars: string[]; secrets: string[]; brokered: string[] }
  /** The environment's setup steps as they ran, output redacted later. */
  setup?: Array<{ run: string; exitCode: number | null; durationMs: number; output: string }>
  /** See `AttemptRecord.setupProcesses`. */
  setupProcesses?: SetupProcess[]
  egress?: EgressRecord
  /** See `AttemptRecord.servedModels`. */
  servedModels?: string[] | null
  /** See `AttemptRecord.askedModels`. */
  askedModels?: string[]
  /** See `AttemptRecord.upstreams`. */
  upstreams?: Array<{ provider: string; calls: number }>
  /** See `AttemptRecord.reportedCostUsd`. */
  reportedCostUsd?: number
  /**
   * PNGs from `c.capture()`. Bytes live in a sidecar next to this JSON
   * (`<stem>.artifacts/<name>.png`) so redact never touches them.
   */
  artifacts?: Array<{
    name: string
    mediaType: 'image/png'
    sha256: string
    bytes: number
    capture: CaptureArtifactMeta
  }>
  /**
   * Tokens the capture vision loop used. Infrastructure only: never harness
   * `usage`, effort, compare or lift.
   */
  captureUse?: CaptureUseSpend
}

/** How a saved PNG was produced. Persist the live window, not the string `'full-page'`. */
export type CaptureArtifactMeta = {
  port: number
  path: string
  viewport?: CaptureWindow
  /** Saved PNG used `captureBeyondViewport`. */
  fullPage?: boolean
  /** Goal strings only; wait beats omitted. */
  instructions?: string[]
  use?: { model: string; moves: number }
}

/** Attempt-level capture vision spend; not harness usage. */
export type CaptureUseSpend = {
  model: string
  moves: number
  usage: TokenUsage | null
}

/** Which environment ran as the control, so the studio can show it. */
export type EvalCompareMeta = {
  baseline: string
  /**
   * Set when `compare.baseline` was omitted: the control is the eval's cascaded `environment`, or
   * an empty environment named `baseline` when there was none.
   */
  from?: 'environment' | 'empty'
}

/** How an eval was sized for the plan: what it asked for, and what a profile changed. */
export type EvalPlan = {
  harnesses: number
  /** Variants run, of those the eval compares; null without `compare`. */
  variants: { run: number; of: number } | null
  /** Set when the eval compares variant cells. */
  compare?: EvalCompareMeta
  /** The eval's questions, answered after its attempts; unset without any, or when a profile dropped them all. */
  questions?: PlannedQuestion[]
  runs: number
  /** The eval's gate policy, or undefined when it was left at the default (`'all'`). */
  gate?: GatePolicy
  attempts: number
  notes: string[]
  /** Why the eval doesn't run at all, e.g. a profile's harness limit left none. */
  skip?: string
  /** Warnings about the eval's setup, e.g. a moving git ref. */
  warnings: string[]
  /** Its sandbox runs as root or with capabilities added back; empty for a skipped eval. */
  sandboxWarnings: SandboxWarning[]
  /** Secrets any of its attempts brokers, as `NAME → host, host`. */
  brokered: string[]
  /** Each distinct restricted egress policy its attempts run under, as the plan prints it. */
  egress: string[]
  /** Each distinct git workspace its attempts start from, as `repo#ref:path`. */
  workspaces: string[]
  /** Resolved camera defaults when any field is set. */
  capture?: CaptureOptions
}

/**
 * A sandbox with more privilege than the default `reeval` user: `docker({ root: true })`, or
 * `docker({ capabilities })`. One per level that set such a sandbox, however many evals inherit it.
 */
export type SandboxWarning = {
  kind: 'root' | 'capabilities'
  /** Which level set the sandbox. */
  level: 'config' | 'profile' | 'group' | 'eval'
  /** That level as reeval names it: `reeval.config.ts`, `profiles.pr.defaults`, `group("net")` or `evaluate("installs deps")`. */
  where: string
  /** The eval file that sets it, for a group or eval; null for the config or a profile. */
  file: string | null
  /** The capabilities added back, for `capabilities`. */
  capabilities?: string[]
  /** The line reeval prints, after `WARNING: ` (root) or `warning: ` (capabilities). */
  message: string
}

/** An attempt's egress policy, and the hosts a restricted one allows on top of its own. */
export type PlannedEgress = { policy: EgressPolicy; auto: string[] }

/** Set when an attempt is registered, so the reporter has it even for skipped attempts. */
export type AttemptMeta = {
  name: string
  groups: string[]
  tags: string[]
  /** The eval's `revision`, as the cascade resolved it; unset when no level sets one. */
  revision?: Revision
  /** Hashes of the eval's own source: what the `sources` fingerprint part covers but `revision`. */
  source: EvalSource
  cell: Cell
  n: number
  /** The harness, then the role (with `compare`), plus `#n` when it has several runs. */
  label: string
  harness: HarnessDescriptor
  sandbox: SandboxDescriptor
  /** The levels that set its sandbox and harness: `reeval.config.ts`, `profiles.pr.defaults`, `group("net")` or `evaluate("x")`; with `pluginBuilds`, the environment its plugin builds come from (`environment review in evals/review.eval.ts`). */
  setBy: { sandbox: string; harness: string; pluginBuilds?: string }
  /** How its cell's attempts decide the cell's outcome; `'none'` when they don't fail the run. */
  gate: CellGate
  /** Set on variant attempts whose compare has a `minLift`. */
  minLift?: number
  /** The secrets this attempt brokers, as `NAME → host, host`. */
  brokered: string[]
  /**
   * The host variables its secrets read, by name: the CLI's own process masks their values on
   * screen, since the attempt's worker is the only other process that knows them.
   */
  secretVars: string[]
  egress: PlannedEgress
  /** The git repository its workspace starts as, which the CLI fetches before any attempt. */
  workspace?: GitWorkspace
  /** The paths its environment's `files` write, layered and sorted; unset when there are none. */
  files?: string[]
  /** Its environment's plugins, layered: a local one's name and parts, else its source. */
  plugins?: string[]
  /** Its environment's plugins with a `build`, layered, which preflight builds into its image. */
  pluginBuilds?: PluginSource[]
  plan: EvalPlan
  /** Why this attempt does not run, e.g. it already completed in a resumed run. */
  skip?: string
  /** Set when the eval is a case of a pooled `evaluate.each`. */
  family?: FamilyMeta
  /** The gateway its harness resolved to; unset when no config, profile or pin names one. */
  gateway?: ResolvedGateway
  /**
   * Its judge's `'provider/model'`, as the config, profile, groups and eval set it, and the
   * gateway its calls go through, so the run checks the judge's key before any attempt starts.
   * Unset for a fake judge, a model object, or none.
   */
  judge?: { model: string; gateway?: GatewayName }
}

/** Where a cell's harness resolved in the `gateway` list, and the entries before it that couldn't serve it. */
export type ResolvedGateway = {
  name: GatewayName
  skipped: Array<{ gateway: GatewayName; why: string }>
}

/** A case's place in its pooled `evaluate.each`. */
export type FamilyMeta = {
  /** `file › group › … › template`, like an eval id with the name template in place of the name. */
  id: string
  /** The name template, e.g. `fixes $id`. */
  name: string
  /** This case's index in the list, from 0. */
  case: number
  /** How many cases the list has. */
  cases: number
}

/** Small summary carried through the engine's task metadata. */
export type EvalMeta = {
  outcome: EvalRecord['outcome']
  errorKind: ErrorKind | null
  judgements: Array<Pick<Verdict, 'verdict' | 'score' | 'threshold'> & { question: string }>
  /** Each turn that ended in an error, as `turn 2 error: <message>`, so a failure shows why. */
  turnErrors?: string[]
  /** Its sandbox couldn't be prepared: reported once per sandbox, and it has no artifacts. */
  prepare?: { ref: string | null; stage: string }
}

export type RunContext = {
  runId: string
  stagingDir: string
  config: ResolvedConfig
  /** `reeval run --runs n`: overrides every level. */
  runs?: number
  /** `reeval run --tag` and the profile's tags: each is a tag, or `!tag` to exclude; all must hold. */
  tags: string[]
  /** How many attempts run at once, across the run. */
  concurrency: number
  profile: ResolvedProfile | null
  /** `-v` (1) or `-vv`/`--trace` (2) streams the attempts' debug lines; 0 only writes debug.log. */
  verbosity?: 0 | 1 | 2
  /** The config file, relative to the current directory, for the debug trace; unset without one. */
  configFile?: string
  /** Attempt keys already finished when this run was resumed; workers register them as skip. */
  completed?: string[]
}
