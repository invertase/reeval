import type { ErrorKind, FileChange, Outcome, TurnStatus } from '../types.ts'

/**
 * One number for every file in the results layout. 2 was the single-file
 * `.es/results/<runId>/result.json`; 3 is the run directory.
 */
export const SCHEMA_VERSION = 3

/** `path` is relative to the run directory; `sha256` is of the redacted bytes on disk. */
export type FileRef = { path: string; sha256: string; bytes: number }

export type GitInfo = {
  sha: string
  branch: string | null
  /** Uncommitted changes outside `.es/` when the run started. */
  dirty: boolean
  /** sha256 of `git diff HEAD` plus the untracked file names, when dirty. */
  diffHash: string | null
  commitTime: string
  shallow: boolean
  /** The `origin` URL with any credentials removed. */
  remote: string | null
}

export type RunnerInfo =
  | { kind: 'ci'; provider: string; runUrl: string | null; attempt: number | null }
  | { kind: 'local'; hostHash: string }

export type JudgementRecord = {
  question: string
  verdict: 'pass' | 'fail'
  score: number
  threshold: number
  model: string
  /** Evaluation models return a probability only, so this is null until a judge explains itself. */
  reason: string | null
  evidence: string[]
}

export type CheckRecord = { command: string; exitCode: number; log: FileRef }

export type TrialFiles = {
  transcript?: FileRef
  final?: FileRef
  diff?: FileRef
  judgeInput?: FileRef
}

export type TrialRecord = {
  kind: 'es-trial'
  schemaVersion: typeof SCHEMA_VERSION
  runId: string
  evalId: string
  n: number
  outcome: Outcome
  error: { kind: ErrorKind; message: string } | null
  durationMs: number
  /** `text` is capped at 4 KB; `final.md` has it whole. */
  turns: Array<{ prompt: string; status: TurnStatus; text: string }>
  judgements: JudgementRecord[]
  checks: CheckRecord[]
  changedFiles: FileChange[]
  files: TrialFiles
}

export type TrialEntry = Omit<
  TrialRecord,
  'kind' | 'schemaVersion' | 'runId' | 'evalId' | 'turns'
> & {
  result: FileRef
}

export type EvalEntry = {
  id: string
  /** Directory name under `evals/`. */
  slug: string
  file: string
  group: string[]
  name: string
  /** Results are comparable only when fingerprints match. */
  fingerprint: string
  sourceHash: string | null
  outcome: Outcome
  /** pass / (pass + fail); infra errors and skips excluded. */
  passRate: number | null
  trials: TrialEntry[]
}

export type RunSummary = {
  evals: number
  pass: number
  fail: number
  infraError: number
  skipped: number
}

export type RunRecord = {
  kind: 'es-run'
  schemaVersion: typeof SCHEMA_VERSION
  runId: string
  status: 'complete' | 'interrupted'
  startedAt: string
  endedAt: string
  durationMs: number
  git: GitInfo | null
  runner: RunnerInfo
  versions: { es: string; vitest: string; node: string; agentCli: string | null; image: string }
  config: {
    harness: string
    model: string | null
    sandbox: string
    judgeModel: string
    threshold: number
    timeoutMs: number
    configHash: string
  }
  redaction: { version: 1 }
  summary: RunSummary
  evals: EvalEntry[]
}

export type IndexEntry = {
  runId: string
  /** Path of `run.json` from the store root. */
  path: string
  status: RunRecord['status']
  startedAt: string
  durationMs: number
  git: Pick<GitInfo, 'sha' | 'branch' | 'dirty' | 'commitTime'> | null
  runner: RunnerInfo['kind']
  harness: string
  model: string | null
  judgeModel: string
  summary: RunSummary
  evals: Array<{ id: string; fingerprint: string; outcome: Outcome }>
}

export type RunIndex = {
  kind: 'es-index'
  schemaVersion: typeof SCHEMA_VERSION
  runs: IndexEntry[]
}
