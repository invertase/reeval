import type { ArtifactLevel, RecordMode } from './history/types.ts'

export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h'}`

/** When an event started: wall clock, and ms since its turn started. */
export type EventTime = { ts: string; atMs: number }

export type FileEditEvent = {
  type: 'file-edit'
  toolCallId: string
  path: string
  kind: 'create' | 'modify' | 'delete'
  /** Line counts, or null when the harness didn't send the content (e.g. deletes). */
  added: number | null
  removed: number | null
}

/**
 * Normalised agent events. Each tool call is one event, merged with its result; `durationMs`
 * is null when the harness never reported the end.
 */
export type TranscriptEvent = EventTime &
  (
    | { type: 'text' | 'reasoning'; text: string; durationMs: number | null }
    | (FileEditEvent & { durationMs: number | null })
    | {
        type: 'web-search'
        toolCallId: string
        query: string
        /** How many sources the harness says it used; Cursor sends no URLs or titles. */
        references: number | null
        durationMs: number | null
      }
    | { type: 'web-fetch'; toolCallId: string; url: string; ok: boolean; durationMs: number | null }
    | {
        type: 'tool'
        toolCallId: string
        tool: string
        input: unknown
        output: unknown
        ok: boolean
        durationMs: number | null
      }
    | { type: 'error'; message: string }
  )

export type ExecResult = { exitCode: number; stdout: string; stderr: string }

export type FileChange = { path: string; status: 'added' | 'modified' | 'deleted' }
export type Diff = { patch: string; files: FileChange[] }

export type TurnStatus = 'completed' | 'aborted' | 'error'

/** One agent turn. Immutable once `t.send()` resolves. */
export type Turn = {
  prompt: string
  /** The agent's final message for this turn. */
  text: string
  status: TurnStatus
  startedAt: string
  durationMs: number
  transcript: TranscriptEvent[]
  /** Workspace changes since the eval started, as of the end of this turn. */
  diff: Diff
  /** Runs in the eval's sandbox. Same as `t.exec`. */
  exec(command: string): Promise<ExecResult>
  readFile(path: string): Promise<string | null>
}

export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue }

/** A canned judge for tests and dry runs; see `fakeJudge()` in `evalsuite/judge`. */
export type FakeJudgeModel = { kind: 'fake-judge'; score: number }

/**
 * `'provider/model'` (e.g. `'google/gemini-3.8-flash'`, `'typesafe-ai/jev'`), an AI SDK
 * evaluation model object (per group, eval or call only), or a fake judge.
 */
export type JudgeModel = string | FakeJudgeModel | { readonly specificationVersion: string }

export type JudgeOptions = {
  model?: JudgeModel
  /** Minimum score (0–1) for a `pass` verdict. */
  threshold?: number
  providerOptions?: Record<string, Record<string, JSONValue>>
}

export type JudgeCallOptions = JudgeOptions & {
  /** What to grade instead of the latest turn: another turn, or a value used as the output. */
  on?: Turn | JSONValue
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
}

export type EvalContext = {
  /** Sends the next turn of this eval's agent session, starting the sandbox on first use. */
  send(prompt: string): Promise<Turn>
  /** Asks the judge a yes/no question about the latest turn (or `options.on`). */
  judge(question: string, options?: JudgeCallOptions): Promise<Verdict>
  exec(command: string): Promise<ExecResult>
  readFile(path: string): Promise<string | null>
  /** Every turn so far, oldest first. */
  readonly turns: readonly Turn[]
  /** Aborted on timeout or Ctrl-C. */
  readonly signal: AbortSignal
}
export type EvalFn = (t: EvalContext) => Promise<void>

export type FakeHarnessDescriptor = {
  kind: 'fake'
  /** Files the fake agent writes into the sandbox on every turn. */
  files?: Record<string, string>
  text?: string
  /** Simulated turn length, honours the abort signal. */
  delayMs?: number
  /** Throw before the first turn starts, to simulate an infra failure. */
  failWith?: string
}
export type CursorHarnessDescriptor = { kind: 'cursor'; model?: string }
export type HarnessDescriptor = FakeHarnessDescriptor | CursorHarnessDescriptor

export type FakeSandboxDescriptor = {
  kind: 'fake'
  /** Parent directory for the per-eval workspace (defaults to the OS temp dir). */
  dir?: string
}
export type DockerSandboxDescriptor = { kind: 'docker'; image?: string }
export type SandboxDescriptor = FakeSandboxDescriptor | DockerSandboxDescriptor

/** The config file is plain data sent to workers, so its judge model can't be an object. */
export type ConfigJudgeOptions = Omit<JudgeOptions, 'model'> & { model?: string | FakeJudgeModel }

export type HistoryConfig = {
  /** Committed history folder (default: `.history` in the directory the evals live in). */
  dir?: string
  /** Artifacts recorded next to each run: every eval's, failing evals' only, or none. */
  artifacts?: ArtifactLevel
}

export type EsConfig = {
  include?: string[]
  harness?: HarnessDescriptor
  sandbox?: SandboxDescriptor
  judge?: ConfigJudgeOptions
  timeout?: Duration
  /** When runs are copied into the history folder: `es record` only, in CI, or on every run. */
  record?: RecordMode
  history?: HistoryConfig
}

export type ConfigContext = {
  /** True when the `CI` environment variable is set. */
  ci: boolean
  command: string
  env: NodeJS.ProcessEnv
}

export type ResolvedConfig = {
  root: string
  include: string[]
  harness: HarnessDescriptor
  sandbox: SandboxDescriptor
  judge: ConfigJudgeOptions & { model: string | FakeJudgeModel; threshold: number }
  timeoutMs: number
  record: RecordMode
  history: { dir: string; artifacts: ArtifactLevel }
}

export type Outcome = 'pass' | 'fail' | 'infra_error' | 'skipped'
export type ErrorKind = 'assertion' | 'timeout' | 'aborted' | 'infra' | 'judge'

export type TurnRecord = Pick<
  Turn,
  'prompt' | 'text' | 'status' | 'transcript' | 'startedAt' | 'durationMs'
> & { raw?: unknown[] }

/** Where an eval's time went, in ms. `agentMs` is the harness turns; `diffMs` reading changes. */
export type PhaseTimings = {
  setupMs: number
  agentMs: number
  diffMs: number
  checksMs: number
  judgeMs: number
}

/** Full per-eval payload, written to disk by the worker. */
export type EvalRecord = {
  outcome: Exclude<Outcome, 'skipped'>
  error: { kind: ErrorKind; message: string } | null
  turns: TurnRecord[]
  /** Workspace changes over the whole eval. */
  diff: Diff | null
  checks: Array<{ command: string; durationMs: number } & ExecResult>
  judgements: Verdict[]
  timings: PhaseTimings
  /** Skills, rules and MCP config visible to the agent, by content hash. */
  context?: Array<{ path: string; sha256: string }>
  /** What each judge call saw, in call order, including calls that errored. */
  judgeInputs?: Array<{ question: string; model: string; state: { [key: string]: JSONValue } }>
}

/** Small summary carried through the engine's task metadata. */
export type EvalMeta = {
  outcome: EvalRecord['outcome']
  errorKind: ErrorKind | null
  judgements: Array<Pick<Verdict, 'verdict' | 'score' | 'threshold'> & { question: string }>
  recordPath: string
}

export type RunContext = { runId: string; resultsDir: string; config: ResolvedConfig }
