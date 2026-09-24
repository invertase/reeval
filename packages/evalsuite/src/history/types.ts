import type { ErrorKind, FileChange, Outcome, TurnStatus } from '../types.ts'

export const SCHEMA_VERSION = 1

export type ArtifactLevel = 'all' | 'failures' | 'none'
export type RecordMode = 'manual' | 'ci' | 'always'

/** `path` is relative to the run's artifact directory; `sha256` is of the bytes on disk. */
export type FileRef = { path: string; sha256: string; bytes: number }

export type GitInfo = {
  /**
   * The commit the run executed at: HEAD when `es run` started. The later commit that adds the
   * history file is a different, descendant commit.
   */
  sha: string
  branch: string | null
  /** Uncommitted changes, outside `.es/` and the history folder, when the run started. */
  dirty: boolean
  /** sha256 of the uncommitted changes (tracked and untracked, as a binary patch), when dirty. */
  diffHash: string | null
  /** Those changes as `worktree.patch` in the artifact dir; apply on `sha` to reproduce. */
  worktreePatch: FileRef | null
  /** Why a dirty run has no `worktree.patch`, e.g. too large or artifacts: 'none'. */
  worktreePatchNote: string | null
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
  /** The model id the provider says served the call, when it reports one. */
  resolvedModel?: string
  /** Evaluation models return a probability only, so this is null until a judge explains itself. */
  reason: string | null
  evidence: string[]
}

export type AttemptFiles = {
  transcript?: FileRef
  final?: FileRef
  diff?: FileRef
  judgeInput?: FileRef
}

export type ContextFile = { path: string; sha256: string }

export type AttemptRecord = {
  n: number
  /** Skills, rules and MCP config visible to the agent in its sandbox, by content hash. */
  context: ContextFile[]
  outcome: Outcome
  error: { kind: ErrorKind; message: string } | null
  durationMs: number
  /** `text` is capped at 4 KB; `final.md` has it whole. */
  turns: Array<{ prompt: string; status: TurnStatus; text: string }>
  judgements: JudgementRecord[]
  checks: Array<{ command: string; exitCode: number; log?: FileRef }>
  /** Files under a dependency directory (node_modules/, .venv/, …) collapse to one entry with `count`. */
  changedFiles: Array<FileChange & { count?: number }>
  files: AttemptFiles
}

export type EvalEntry = {
  id: string
  /** Directory name inside the artifact directory. */
  slug: string
  file: string
  group: string[]
  name: string
  /** Results are comparable only when fingerprints match. */
  fingerprint: string
  /** sha256 of the eval file (its imports aren't traced yet). */
  sourceHash: string | null
  /** Evals have no fixtures until workspace seeding lands; always null for now. */
  fixtureHash: string | null
  outcome: Outcome
  /** pass / (pass + fail); infra errors and skips excluded. */
  passRate: number | null
  attempts: AttemptRecord[]
}

export type RunSummary = {
  evals: number
  pass: number
  fail: number
  infraError: number
  skipped: number
}

/** Tokens and USD, null when the harness or judge doesn't report them (Cursor reports none). */
export type Cost = {
  usd: number | null
  inputTokens: number | null
  outputTokens: number | null
  source: 'reported' | 'unreported'
}

export type RunRecord = {
  kind: 'es-run'
  schemaVersion: typeof SCHEMA_VERSION
  /** Also the file name: `<UTC start>_<short sha>_<author or ci>`. */
  runId: string
  status: 'complete' | 'interrupted'
  startedAt: string
  endedAt: string
  durationMs: number
  author: string
  git: GitInfo | null
  runner: RunnerInfo
  dependencies: {
    /** Lockfiles in the project root (and the repo root, if different), by content hash. */
    lockfiles: Array<{ path: string; sha256: string }>
  }
  environment: Environment
  /** What a rerun can't pin down, so differences aren't mistaken for regressions. */
  reproducibility: { notes: string[] }
  config: {
    harness: string
    model: string | null
    sandbox: string
    judgeModel: string
    threshold: number
    timeoutMs: number
    configHash: string
  }
  cost: Cost
  /** Which artifacts sit next to this record. Refs to files that weren't kept are removed. */
  artifacts: ArtifactLevel
  redaction: { version: 1 }
  summary: RunSummary
  evals: EvalEntry[]
}

export type Environment = {
  es: string
  node: string
  os: string
  arch: string
  /** null for the fake sandbox. `id` is content-addressed; `repoDigests` only exist once pushed. */
  image: { ref: string; id: string; repoDigests: string[] } | null
  agentCli: string | null
  /** Exact versions of the packages that run and grade the agent. */
  packages: Record<string, string>
  harness: { kind: string; model: string | null; resolvedModel: string | null }
  judge: {
    model: string
    /** Model ids the provider reported serving, across every judge call in the run. */
    resolvedModels: string[]
    threshold: number
    /** Changes when ES, the AI SDK or the provider adapter (and so the judge prompt) change. */
    version: string
  }
  /** Union of every attempt's context files. */
  context: ContextFile[]
}

/** One line of the derived, locally cached history listing. */
export type HistoryEntry = {
  runId: string
  recorded: boolean
  status: RunRecord['status']
  startedAt: string
  author: string
  git: Pick<GitInfo, 'sha' | 'branch' | 'dirty'> | null
  runner: RunnerInfo['kind']
  harness: string
  model: string | null
  summary: RunSummary
  evals: Array<{ id: string; fingerprint: string; outcome: Outcome }>
}
