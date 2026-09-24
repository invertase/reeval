import type {
  AttemptImage,
  Cell,
  EnvironmentRecord,
  ErrorKind,
  FileChange,
  Outcome,
  PhaseTimings,
  TurnStatus,
} from '../types.ts'

/** Stays 1 while ES is pre-release: the record changes in place. */
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

/** One failed judge try that was retried, and the backoff before the next. */
export type JudgeRetry = { error: string; delayMs: number }

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
  /** Transient provider errors retried before this verdict, with the backoff before each retry. */
  retries?: JudgeRetry[]
}

export type AttemptFiles = {
  transcript?: FileRef
  /** Unnormalised harness stream parts, only with `ES_RAW_TRANSCRIPT=1`. */
  rawTranscript?: FileRef
  diff?: FileRef
  judgeInput?: FileRef
}

export type ContextFile = { path: string; sha256: string }

export type AttemptRecord = {
  /** `<cell key>#<n>`. */
  id: string
  /** The cell's key; see `EvalEntry.cells`. */
  cell: string
  /** Run number within the cell, from 1. */
  n: number
  /** The image the container started from; null for the fake sandbox. */
  image: AttemptImage | null
  /** Names of the variables and secrets set in the sandbox; values are never recorded. */
  env: { vars: string[]; secrets: string[] }
  /** Skills, rules and MCP config visible to the agent in its sandbox, by content hash. */
  context: ContextFile[]
  outcome: Outcome
  error: { kind: ErrorKind; message: string } | null
  durationMs: number
  /** `text` is the agent's final message, whole unless it's over 64 KB. */
  turns: Array<{
    prompt: string
    status: TurnStatus
    startedAt: string
    durationMs: number
    text: string
  }>
  timings: PhaseTimings
  /** Counts from the transcript, so a run's shape is visible without reading it. */
  activity: {
    tools: number
    fileEdits: number
    webSearches: number
    webFetches: number
    reasoningMs: number
  }
  judgements: JudgementRecord[]
  checks: Array<{ command: string; exitCode: number; durationMs: number; log?: FileRef }>
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
  tags: string[]
  /** `fail` if any cell failed, else `infra_error` if any errored, else `skipped` if all were, else `pass`. */
  outcome: Outcome
  /** pass / (pass + fail) over every attempt; infra errors and skips excluded. */
  passRate: number | null
  cells: CellRecord[]
  attempts: AttemptRecord[]
}

/** One harness × environment × sandbox combination of an eval, and how its attempts went. */
export type CellRecord = Cell & {
  /** Covers the eval source, harness, environment digest, image and judge settings. */
  fingerprint: string
  runs: number
  pass: number
  fail: number
  infraError: number
  skipped: number
  passRate: number | null
  outcome: Outcome
}

/** Counts attempts, except `evals`. */
export type RunSummary = {
  evals: number
  attempts: number
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
  stack: Stack
  /** Each environment the run applied, fingerprinted; secret values are never included. */
  environments: EnvironmentRecord[]
  config: {
    harnesses: string[]
    sandboxes: string[]
    environments: string[]
    runs: number
    judgeModel: string | null
    threshold: number
    timeoutMs: number
    /** Attempts that ran at once; not part of `configHash`, since it doesn't change results. */
    concurrency: number
    configHash: string
  }
  cost: Cost
  /** Which artifacts sit next to this record. Refs to files that weren't kept are removed. */
  artifacts: ArtifactLevel
  redaction: { version: 1 }
  summary: RunSummary
  evals: EvalEntry[]
}

/** What ran and graded the agents: the machine, images, harnesses and judge. */
export type Stack = {
  es: string
  node: string
  os: string
  arch: string
  /** Every image an attempt started from. `id` is content-addressed; `repoDigests` only exist once pushed. */
  images: Array<AttemptImage & { repoDigests: string[] }>
  /** Exact versions of the packages that run and grade the agent. */
  packages: Record<string, string>
  harnesses: Array<{ id: string; kind: string; model: string | null }>
  judge: {
    /** The config's default model; groups, evals and calls may use others (see each verdict). */
    model: string | null
    /** Model ids the provider reported serving, across every judge call in the run. */
    resolvedModels: string[]
    threshold: number
    /** Changes when ES, the AI SDK or the provider adapter (and so the judge prompt) change. */
    version: string
  }
  /** Union of every attempt's context files. */
  context: ContextFile[]
  /** What eval fingerprints hash; fingerprints from different scopes aren't comparable. */
  fingerprintScope: string[]
}

/** The parts of a run's stack that `es compare` checks for drift. */
export type StackSummary = {
  imageIds: string[]
  agentClis: string[]
  harnesses: string[]
  /** `name@digest` per environment. */
  environments: string[]
  judgeModel: string | null
  /** What the judge provider reported serving; differs from `judgeModel` on silent updates. */
  judgeServed: string[]
  judgeVersion: string
  threshold: number
  fingerprintScope: string[]
}

/** Per-cell attempt counts in a `HistoryEntry`, enough for pass rates without the record. */
export type CellCounts = Pick<
  CellRecord,
  'key' | 'runs' | 'pass' | 'fail' | 'infraError' | 'skipped'
>

/**
 * One line of the derived history listing: cached locally by the CLI, and the run header in the
 * studio's index shards.
 */
export type HistoryEntry = {
  runId: string
  recorded: boolean
  status: RunRecord['status']
  startedAt: string
  durationMs: number
  author: string
  git: Pick<GitInfo, 'sha' | 'branch' | 'dirty'> | null
  runner: RunnerInfo['kind']
  /** The CI provider and its run page, for CI runs. */
  ci: { provider: string; runUrl: string | null } | null
  harnesses: string[]
  summary: RunSummary
  costUsd: number | null
  stack: StackSummary
  evals: Array<{
    id: string
    slug: string
    fingerprint: string
    outcome: Outcome
    passRate: number | null
    cells: CellCounts[]
  }>
}
