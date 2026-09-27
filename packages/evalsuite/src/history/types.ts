import type {
  AttemptImage,
  Cell,
  CellGate,
  EgressRecord,
  EnvironmentRecord,
  ErrorKind,
  FileChange,
  Outcome,
  PhaseTimings,
  TokenUsage,
  TurnStatus,
  WebEventType,
} from '../types.ts'
import type { CellEffort } from '../view/effort.ts'

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
  | {
      kind: 'ci'
      provider: string
      runUrl: string | null
      attempt: number | null
      /** The pull request a CI run built, when the provider says (GitHub Actions). */
      pr: { number: number | null; baseRef: string | null } | null
    }
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
  /**
   * `<index>:<sha256(question) prefix>`: the same question at the same place in the eval, so a
   * verdict can be followed across runs (and an edited question starts a new series).
   */
  key: string
  /** Transient provider errors retried before this verdict, with the backoff before each retry. */
  retries?: JudgeRetry[]
}

export type AttemptFiles = {
  /** Each environment setup step's command, exit code, duration and output. */
  setupLog?: FileRef
  transcript?: FileRef
  /** Unnormalised harness stream parts, only with `ES_RAW_TRANSCRIPT=1`. */
  rawTranscript?: FileRef
  diff?: FileRef
  judgeInput?: FileRef
}

export type ContextFile = { path: string; sha256: string }

export type AttemptRecord = {
  /** `<eval key> # <cell key>#<n>`: unique in the run. */
  key: string
  /** `<cell key>#<n>`: unique in its eval. */
  id: string
  /** The cell's key; see `EvalEntry.cells`. */
  cell: string
  /** Run number within the cell, from 1. */
  n: number
  /** Start order across the run, from 1; null for attempts that never started. */
  seq: number | null
  startedAt: string | null
  /** The image the container started from, in `stack.images`; null for the fake sandbox. */
  imageId: string | null
  /** Names of the variables and secrets set in the sandbox, and the brokered ones; never values. */
  env: { vars: string[]; secrets: string[]; brokered: string[] }
  /** Skills, rules and MCP config visible to the agent in its sandbox, by content hash. */
  context: ContextFile[]
  /** The egress policy and, when the sandbox records it, the hosts contacted and refused; null if it never ran. */
  egress: EgressRecord | null
  /**
   * The models the harness's own API requests asked for, as the egress gateway saw them (the
   * served model, e.g. `gemini-3.8-flash` for the id `gemini-3.8-flash-low`, plus any the agent
   * uses on the side); null when its requests don't name one (Cursor) or nothing recorded them.
   */
  servedModels: string[] | null
  outcome: Outcome
  error: { kind: ErrorKind; message: string } | null
  durationMs: number
  /** `text` is the agent's final message, cut at 8 KB; the whole of it is in `transcript.jsonl`. */
  turns: Array<{
    prompt: string
    status: TurnStatus
    startedAt: string
    durationMs: number
    text: string
    /** Tokens the turn used; null when the harness reports none. */
    usage: TokenUsage | null
    /** The model the harness says served the turn; null when it reports none. */
    model: string | null
    /** Event types the harness can't report; see `Turn.unreported`. */
    unreported: WebEventType[]
    /** The turn's first error, such as a provider's billing or auth error, cut at 1 KB; else null. */
    error: string | null
  }>
  /** Tokens across the attempt's turns; null when the harness reported none. */
  usage: TokenUsage | null
  timings: PhaseTimings
  /** Counts from the transcript, so a run's shape is visible without reading it. */
  activity: {
    tools: number
    fileEdits: number
    /** Null when a turn with none couldn't report them (`unreported`), not a count of 0 that isn't one. */
    webSearches: number | null
    webFetches: number | null
    reasoningMs: number
  }
  judgements: JudgementRecord[]
  checks: Array<{ command: string; exitCode: number; durationMs: number; log?: FileRef }>
  /** Files under a dependency directory (node_modules/, .venv/, …) collapse to one entry with `count`. */
  changedFiles: Array<FileChange & { count?: number }>
  files: AttemptFiles
}

export type EvalEntry = {
  /** `file › group › … › name`, as shown. */
  id: string
  /** What the eval is matched on across runs; its `id` for now. */
  key: string
  /** Directory name inside the artifact directory, from `key`. */
  slug: string
  file: string
  group: string[]
  name: string
  /** Results are comparable only when fingerprints match. */
  fingerprint: string
  /** The eval file and every local file it imports, directly or not, by content hash. */
  sources: Array<{ path: string; sha256: string }>
  tags: string[]
  /**
   * Over gated cells: `fail` if any failed, else `infra_error` if any errored, else `skipped` if
   * all were, else `pass`. An ungated cell's failures don't fail the eval.
   */
  outcome: Outcome
  /** A placeholder, `evaluate.todo` or `group.todo`: it never runs, and its outcome is `skipped`. */
  todo: boolean
  /** pass / (pass + fail) over the gated cells' attempts; infra errors and skips excluded. */
  passRate: number | null
  cells: CellRecord[]
  attempts: AttemptRecord[]
}

/** A variant cell's pass rate against the control's, on the same harness and sandbox. */
export type Lift = {
  /** The control cell's key. */
  vs: string
  /** Passes out of counted attempts (passes and fails) on each side. */
  control: { pass: number; counted: number }
  variant: { pass: number; counted: number }
  /** Variant pass rate minus control pass rate, from -1 to 1. */
  points: number
  /** 95% interval on the difference, by Newcombe's hybrid score method from two Wilson intervals. */
  interval: { lo: number; hi: number; level: 0.95; method: 'newcombe-wilson' }
  /** The interval spans 0: the attempts can't tell the variant from the control. */
  withinNoise: boolean
  /** Set when the compare has a `minLift`; the cell fails when `interval.lo` is below it. */
  minLift?: number
}

/** Each input of a cell fingerprint, hashed on its own, so a change can be named. */
export type FingerprintParts = {
  /** Over `EvalEntry.sources`. */
  sources: string
  /** Over the harness descriptor, less concurrency caps. */
  harness: string
  environment: string | null
  image: string | null
  agentCli: string | null
  /** Over the judge's model, threshold and version. */
  judge: string
  /** Over the attempt's context files. */
  context: string
}

/** One harness and environment of an eval, and how its attempts went. */
export type CellRecord = Cell & {
  /** `sha256` of `fingerprintParts`; results are comparable only when it matches. */
  fingerprint: string
  fingerprintParts: FingerprintParts
  /** The environment's digest: the join key into `RunRecord.environments`; null for none. */
  environmentDigest: string | null
  harnessKind: string
  /** The configured harness model, when it has one. */
  model: string | null
  /** How the attempts decide the cell's outcome; `'none'` when it doesn't fail the eval. */
  gate: CellGate
  /** Environment keys the variant replaced on the control's (or a child on its parent's). */
  overrides: string[]
  runs: number
  pass: number
  fail: number
  infraError: number
  skipped: number
  passRate: number | null
  /** By `gate` (`'none'` reports the worst outcome); a variant below its `minLift` fails too. */
  outcome: Outcome
  lift?: Lift
}

/** Counts attempts, except `evals`. */
export type RunSummary = {
  evals: number
  attempts: number
  pass: number
  /** Every failed attempt, including `notGated` ones. */
  fail: number
  /** Failed attempts in ungated cells (controls, by default), which don't fail the run. */
  notGated: number
  infraError: number
  skipped: number
}

/** The tokens the run used, as the harnesses count them; ES prices nothing. */
export type Cost = {
  /** Prompt tokens, cache reads and writes included. */
  inputTokens: number | null
  outputTokens: number | null
  /** The same totals split as each turn reports them. */
  usage: TokenUsage | null
  source: 'reported' | 'unreported'
}

export type RunRecord = {
  kind: 'es-run'
  schemaVersion: typeof SCHEMA_VERSION
  /** Also the file name: `<UTC start>_<short sha>_<author or ci>`. */
  runId: string
  /** `budget` when `budget.duration` stopped new attempts from starting. */
  status: 'complete' | 'interrupted' | 'budget'
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
  /** The profile the run was sized with, and why it was chosen. */
  profile: {
    name: string
    reason: string
    defaults: {
      harness?: string[]
      environment?: string
      sandbox?: string
      runs?: number
      timeout?: string | number
      env?: string[]
    }
    limit: {
      runs?: number
      compare?: false | { maxVariants: number }
      harness?: string[]
    }
  } | null
  /** What the run planned before it started. */
  plan: { evals: number; cells: number; attempts: number; estimateMs: number }
  budget: { attempts?: number; duration?: string | number } | null
  config: {
    sandbox: string
    environment: string | null
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
  /**
   * Each harness: its configured `model`, and `resolvedModels`, what it reported serving across
   * the run's turns with the variant it resolved (`composer-2.5[fast=true]` for `composer-2.5`
   * without `params`); empty when it reports none.
   */
  harnesses: Array<{
    id: string
    kind: string
    /** The configured model, when the harness has one. */
    model: string | null
    /**
     * The models the harness reported serving, across every turn in the run, with the variant it
     * resolved (`composer-2.5[fast=true]` for `composer-2.5` with no `params`); empty when it
     * reports none.
     */
    resolvedModels: string[]
  }>
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

/** A cell in a `HistoryEntry`: enough to follow cells, variants and lift across runs. */
export type HistoryCell = Pick<
  CellRecord,
  | 'key'
  | 'role'
  | 'variant'
  | 'harness'
  | 'model'
  | 'environment'
  | 'environmentDigest'
  | 'gate'
  | 'fingerprint'
  | 'fingerprintParts'
  | 'runs'
  | 'pass'
  | 'fail'
  | 'infraError'
  | 'skipped'
  | 'passRate'
  | 'outcome'
> & {
  lift?: { vs: string; points: number; lo: number; hi: number; withinNoise: boolean }
  /** Median tool calls and agent time over the counted attempts; null when none counted. */
  effort: CellEffort | null
}

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
  /** The CI provider, its run page and pull request, for CI runs. */
  ci: {
    provider: string
    runUrl: string | null
    pr: { number: number | null; baseRef: string | null } | null
  } | null
  harnesses: string[]
  summary: RunSummary
  /** The run's tokens, summed from the turns that reported them. */
  usage: TokenUsage | null
  stack: StackSummary
  evals: Array<{
    id: string
    key: string
    slug: string
    fingerprint: string
    sources: EvalEntry['sources']
    outcome: Outcome
    passRate: number | null
    cells: HistoryCell[]
  }>
}
