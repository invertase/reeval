export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h'}`

export type TranscriptEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown }
  | { type: 'error'; message: string }

export type ExecResult = { exitCode: number; stdout: string; stderr: string }

export type FileChange = { path: string; status: 'added' | 'modified' | 'deleted' }
export type Diff = { patch: string; files: FileChange[] }

export type RunStatus = 'completed' | 'aborted' | 'error'

export type Run = {
  prompt: string
  text: string
  status: RunStatus
  transcript: TranscriptEvent[]
  diff: Diff
  exec(command: string): Promise<ExecResult>
  readFile(path: string): Promise<string | null>
}

export type Agent = { run(prompt: string): Promise<Run> }

export type Verdict = {
  verdict: 'pass' | 'fail' | 'inconclusive'
  reason: string
  evidence: string[]
}

export type Judge = (run: Run, question: string) => Promise<Verdict>

export type EvalContext = { agent: Agent; judge: Judge; signal: AbortSignal }
export type EvalFn = (ctx: EvalContext) => Promise<void>

export type FakeHarnessDescriptor = {
  kind: 'fake'
  /** Files the fake agent writes into the sandbox. */
  files?: Record<string, string>
  text?: string
  /** Simulated turn length, honours the abort signal. */
  delayMs?: number
  /** Throw before the turn starts, to simulate an infra failure. */
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

export type JudgeConfig = {
  model?: string
  /** Canned verdict instead of calling a model. For tests and dry runs. */
  fake?: Verdict
}

export type EsConfig = {
  include?: string[]
  harness?: HarnessDescriptor
  sandbox?: SandboxDescriptor
  judge?: JudgeConfig
  timeout?: Duration
}

export type ResolvedConfig = {
  root: string
  include: string[]
  harness: HarnessDescriptor
  sandbox: SandboxDescriptor
  judge: Required<Pick<JudgeConfig, 'model'>> & Pick<JudgeConfig, 'fake'>
  timeoutMs: number
}

export type Outcome = 'pass' | 'fail' | 'infra_error' | 'skipped'
export type ErrorKind = 'assertion' | 'timeout' | 'aborted' | 'infra' | 'judge'

export type Judgement = {
  question: string
  model: string
  verdict: Verdict['verdict']
  reason: string
  evidence: string[]
}

/** Full per-eval payload, written to disk by the worker. */
export type EvalRecord = {
  outcome: Exclude<Outcome, 'skipped'>
  error: { kind: ErrorKind; message: string } | null
  agent: { prompt: string; text: string; status: string; transcript: TranscriptEvent[] } | null
  diff: Diff | null
  checks: Array<{ command: string } & ExecResult>
  judgements: Judgement[]
}

/** Small summary carried through the engine's task metadata. */
export type EvalMeta = {
  outcome: EvalRecord['outcome']
  errorKind: ErrorKind | null
  verdict: { verdict: Verdict['verdict']; reason: string } | null
  recordPath: string
}

export type RunContext = { runId: string; resultsDir: string; config: ResolvedConfig }

export type EsResult = {
  schemaVersion: 1
  runId: string
  startedAt: string
  durationMs: number
  versions: { es: string; vitest: string; agentCli: string | null; image: string }
  config: { harness: HarnessDescriptor; sandbox: SandboxDescriptor; judgeModel: string }
  summary: { passed: number; failed: number; infraError: number; skipped: number }
  evals: Array<
    {
      id: string
      file: string
      name: string
      outcome: Outcome
      durationMs: number
    } & Omit<EvalRecord, 'outcome'>
  >
}
