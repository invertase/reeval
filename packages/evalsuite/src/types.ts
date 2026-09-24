import type { ResultsStore } from './store/types.ts'

export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h'}`

export type TranscriptEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown }
  | { type: 'error'; message: string }

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

/** Where run history goes beyond `.es/`. Main process only: never sent to eval workers. */
export type ResultsConfig = {
  /** The team store `es publish` and `es pull` use, e.g. `gitBranchStore()`. */
  store?: ResultsStore
}

export type EsConfig = {
  include?: string[]
  harness?: HarnessDescriptor
  sandbox?: SandboxDescriptor
  judge?: ConfigJudgeOptions
  timeout?: Duration
  results?: ResultsConfig
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
}

export type Outcome = 'pass' | 'fail' | 'infra_error' | 'skipped'
export type ErrorKind = 'assertion' | 'timeout' | 'aborted' | 'infra' | 'judge'

export type TurnRecord = Pick<Turn, 'prompt' | 'text' | 'status' | 'transcript'>

/** Full per-eval payload, written to disk by the worker. */
export type EvalRecord = {
  outcome: Exclude<Outcome, 'skipped'>
  error: { kind: ErrorKind; message: string } | null
  turns: TurnRecord[]
  /** Workspace changes over the whole eval. */
  diff: Diff | null
  checks: Array<{ command: string } & ExecResult>
  judgements: Verdict[]
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
