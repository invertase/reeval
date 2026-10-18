import type {
  AssertionRecord,
  AttemptError,
  AttemptImage,
  Cell,
  CellGate,
  CompareAnswer,
  EgressRecord,
  EnvironmentRecord,
  EvalCompareMeta,
  FileChange,
  JudgeArtifactRef,
  Outcome,
  PhaseTimings,
  ResolvedJudgeStateOptions,
  SandboxWarning,
  StartRetry,
  TokenUsage,
  TurnStatus,
  WebEventType,
} from '../types.ts'
import type { CellEffort } from '../view/effort.ts'

/** Stays 1 while reeval is pre-release: the record changes in place. */
export const SCHEMA_VERSION = 1

export type ArtifactLevel = 'all' | 'failures' | 'none'
export type RecordMode = 'manual' | 'ci' | 'always'

/** `path` is relative to the run's artifact directory; `sha256` is of the bytes on disk. */
export type FileRef = { path: string; sha256: string; bytes: number }

/** A generic attempt file from `c.capture()` (and later video). */
export type ArtifactRef = FileRef & {
  name: string
  mediaType: 'image/png'
  /** Set when the file came from `c.capture()`. */
  capture?: {
    port: number
    path: string
    /** The live window, never the string `'full-page'`. */
    viewport?: { width: number; height: number }
    /** Saved PNG used `captureBeyondViewport`. */
    fullPage?: boolean
    /** Goal strings only; wait beats omitted. */
    instructions?: string[]
    use?: { model: string; moves: number }
  }
}

export type GitInfo = {
  /**
   * The commit the run executed at: HEAD when `reeval run` started. The later commit that adds the
   * history file is a different, descendant commit.
   */
  sha: string
  branch: string | null
  /** Uncommitted changes, outside `.reeval/` and the history folder, when the run started. */
  dirty: boolean
  /** sha256 of the uncommitted changes (tracked and untracked, as a binary patch), when dirty. */
  diffHash: string | null
  /** Those changes as `worktree.patch` in the artifact dir; apply on `sha` to reproduce. */
  worktreePatch: FileRef | null
  /**
   * Why a dirty run has no `worktree.patch`: too large, artifacts: 'none', or it looked like it held
   * a secret (then where, and which rule, never the value).
   */
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
  /** Captures this call sent the judge as file parts, when any. */
  artifacts?: JudgeArtifactRef[]
}

export type AttemptFiles = {
  /** Each environment setup step's command, exit code, duration and output. */
  setupLog?: FileRef
  transcript?: FileRef
  /** Unnormalised harness stream parts, only with `REEVAL_RAW_TRANSCRIPT=1`. */
  rawTranscript?: FileRef
  diff?: FileRef
  judgeInput?: FileRef
  /** PNGs from `c.capture()`, under `artifacts/<name>.png`. */
  artifacts?: ArtifactRef[]
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
   * The models the harness's own API calls were served by, as the egress gateway saw them: named
   * in the request (e.g. `gemini-3.8-flash` for the id `gemini-3.8-flash-low`, plus any the agent
   * uses on the side) or, for Codex, in the response, with its effort
   * (`gpt-5.6-luna[effort=medium]`); null when neither names one (Cursor) or nothing
   * recorded them.
   */
  servedModels: string[] | null
  /**
   * The reasoning effort the harness factory asked for (`claudeCode({ effort: 'high' })`);
   * null when the factory left it unset. Fast is not this.
   */
  effort: string | null
  /**
   * The reasoning effort the harness's API said it ran at, from `servedModels` /
   * each turn's `model` (`medium` from `gpt-5.6-luna[effort=medium]`); null when those
   * labels name none. Fast (`[fast=true]`) is not this.
   */
  servedEffort: string | null
  outcome: Outcome
  error: AttemptError | null
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
  /**
   * Tokens the capture vision loop used. Infrastructure only: never folded
   * into `usage`, effort, compare or lift.
   */
  captureUse?: { model: string; moves: number; usage: TokenUsage | null }
  timings: PhaseTimings
  /** Counts from the transcript, so a run's shape is visible without reading it. `webSearches` includes refused searches. */
  activity: {
    tools: number
    fileEdits: number
    /** Every `web-search` event, including refused ones. Null when a turn with none couldn't report them (`unreported`). */
    webSearches: number | null
    webFetches: number | null
    reasoningMs: number
  }
  judgements: JudgementRecord[]
  /** Harness session starts that didn't become ready within `startTimeout` and were started again (at most one). */
  startRetries?: StartRetry[]
  checks: Array<{ command: string; exitCode: number; durationMs: number; log?: FileRef }>
  /** Every `expect` and `expect.soft` matcher call that settled, in call order; unset with none. */
  assertions?: AssertionRecord[]
  /** Files under a dependency directory (node_modules/, .venv/, …) collapse to one entry with `count`. */
  changedFiles: Array<FileChange & { count?: number }>
  files: AttemptFiles
}

export type EvalEntry = {
  /** `file › group › … › name`, as shown. */
  id: string
  /** What the eval is matched on across runs; currently the same as `id`. */
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
  /** The baseline environment, when the eval uses `compare`. */
  compare?: EvalCompareMeta
  /**
   * Over gated cells: `fail` if any failed, else `infra_error` if any is (a cell is `infra_error`
   * only when nothing counted), else `skipped` if all were, else `pass`. An ungated cell's
   * failures don't fail the eval.
   */
  outcome: Outcome
  /** A placeholder, `evaluate.todo` or `group.todo`: it never runs, and its outcome is `skipped`. */
  todo: boolean
  /** pass@1, pass / (pass + fail), over the gated cells' attempts; infra errors and skips excluded. */
  passRate: number | null
  cells: CellRecord[]
  attempts: AttemptRecord[]
  /**
   * The compare's questions, answered after its attempts by pairwise votes, one per question;
   * unset without any. They annotate: `outcome` and `passRate` never depend on them. Each vote
   * may include a short `reason` (capped). `reeval analyze` includes each answer in the digest
   * (rates by cut, votes, ties, a failed call, a sample of reasons). Each answer's `input` is
   * `<eval-slug>/questions/<n>.json`: every call its model was sent, per pair and order, secrets
   * masked and screenshots as refs; unset where the eval's files weren't kept.
   */
  answers?: CompareAnswer[]
  /** Set on each case of a pooled `evaluate.each`; `RunRecord.families` has the suite. */
  family?: { id: string; name: string; case: number; cases: number }
}

/** A 95% interval on a pooled rate or difference. */
export type FamilyInterval = {
  lo: number
  hi: number
  level: 0.95
  /**
   * `wilson` / `newcombe-paired`: one counted attempt a case and side, so each case is one
   * Bernoulli trial (or pair). `t-cases`: several, so a t interval over the cases' pass@1, with
   * attempts within a case never counted as independent.
   */
  method: 'wilson' | 'newcombe-paired' | 't-cases'
}

/** One cell's pass@1 over a family's cases. */
export type FamilyRate = {
  /** The cell's key, the same in every case. */
  cell: string
  /** Cases with at least one counted attempt in this cell. */
  cases: number
  /** Passes and counted attempts over those cases. */
  pass: number
  counted: number
  /** The mean of the cases' pass@1; at one attempt a case, `pass / counted`. */
  rate: number
  interval: FamilyInterval
}

/**
 * `lift` / `drop`: the interval excludes 0. `noise`: it doesn't. `insufficient`: fewer than 6
 * discordant pairs (one attempt a case) or 6 paired cases (several), where no test can decide.
 */
export type FamilyVerdict = 'lift' | 'drop' | 'noise' | 'insufficient'

/** One effort metric over a family's paired cases. */
export type FamilyEffortMetric = {
  /** Cases with a value on both sides. */
  pairs: number
  /** The median over cases of the variant's per-case median, over the control's; null at 0. */
  ratio: number | null
  /** Wilcoxon signed-rank over the per-case differences; null when every difference is 0. */
  p: number | null
  /** `insufficient` below 6 non-zero differences, where the exact test can't reach 0.05. */
  verdict: 'fewer' | 'more' | 'noise' | 'insufficient'
}

/** The variant's effort against the control's, paired by case. */
export type FamilyEffort = {
  tools: FamilyEffortMetric
  agentMs: FamilyEffortMetric
  /** Over the cases where every counted attempt reported usage; omitted when none did. */
  tokens?: FamilyEffortMetric
}

/** A variant cell against its control over a family's cases, paired by case. */
export type FamilyLift = {
  /** The variant cell's key. */
  variant: string
  /** The control cell's key. */
  vs: string
  /** Cases with counted attempts on both sides. */
  pairs: number
  /** Mean pass@1 over the paired cases on each side. */
  variantRate: number
  controlRate: number
  /** Set at one attempt a case and side: pairs where only one side passed. */
  discordant?: { variantOnly: number; controlOnly: number }
  /** Variant minus control, from -1 to 1. */
  points: number
  interval: FamilyInterval
  /** McNemar's exact p (one attempt a case), else Wilcoxon signed-rank over the cases. */
  p: number | null
  /** The interval spans 0. */
  withinNoise: boolean
  verdict: FamilyVerdict
  /** The compare's `minLift`: on a family it gates this lower bound, not each case's. */
  minLift?: number
  /** `fail` when `interval.lo` is below `minLift`. */
  outcome: 'pass' | 'fail'
  effort?: FamilyEffort
}

/** A pooled `evaluate.each`: its cases as samples of one suite. Each case is also an eval. */
export type FamilyRecord = {
  /** `file › group › … › template`. */
  id: string
  file: string
  group: string[]
  /** The name template, e.g. `fixes $id`. */
  name: string
  /** Cases in the list. */
  cases: number
  /** Cases with an eval in this run; fewer when a filter or tag left some out. */
  ran: number
  /** One per cell. */
  rates: FamilyRate[]
  /** One per variant cell, with `compare`. */
  lifts: FamilyLift[]
  /** `fail` when a lift is below its `minLift`. The cases still pass or fail on their own. */
  outcome: 'pass' | 'fail'
}

/** A variant cell's pass@1 against the control's, on the same harness and sandbox. */
export type Lift = {
  /** The control cell's key. */
  vs: string
  /** Passes out of counted attempts (passes and fails) on each side. */
  control: { pass: number; counted: number }
  variant: { pass: number; counted: number }
  /** Variant pass@1 minus control pass@1, from -1 to 1. */
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
  /** Over the judge's model, threshold and version, and the config's `state` when it sets one. */
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
  /**
   * The reasoning effort the harness factory asked for; null when it left it unset.
   * Fast is not this.
   */
  effort: string | null
  /** How the attempts decide the cell's outcome; `'none'` when it doesn't fail the eval. */
  gate: CellGate
  /** Environment keys the variant replaced on the control's (or a child on its parent's). */
  overrides: string[]
  runs: number
  pass: number
  fail: number
  infraError: number
  skipped: number
  /** pass@1: pass / (pass + fail); infra errors and skips excluded. */
  passRate: number | null
  /**
   * By `gate`. `'all'` (pass^k: every counted attempt passes) matches `{ passRate: 1 }`;
   * `{ passRate }` is a pass@1 threshold. Infra only when nothing counted; `'none'`
   * reports the worst outcome. A variant below its `minLift` fails too.
   */
  outcome: Outcome
  lift?: Lift
  /**
   * Each check (assertion label) seen in any attempt of the eval, over this cell's counted
   * attempts; on a variant cell, the control's beside it. Unset when no attempt recorded any.
   */
  checks?: CellCheck[]
}

/** How often one check passed: a counted attempt that never reached it counts it `notRun`. */
export type CheckTally = { pass: number; fail: number; error: number; notRun: number }

/**
 * One check over a cell's counted attempts. `verdict` (variant cells): `discriminates` when it
 * passes on every counted attempt of one side and none of the other; `both-pass` or `both-fail`
 * when it does the same on both sides, so it can't tell them apart; `mixed` otherwise.
 */
export type CellCheck = CheckTally & {
  label: string
  control?: CheckTally
  verdict?: CheckVerdict
}

export type CheckVerdict = 'discriminates' | 'both-pass' | 'both-fail' | 'mixed'

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

/** The tokens the run used, as the harnesses count them; reeval prices nothing. */
export type Cost = {
  /** Prompt tokens, cache reads and writes included. */
  inputTokens: number | null
  outputTokens: number | null
  /** The same totals split as each turn reports them. */
  usage: TokenUsage | null
  source: 'reported' | 'unreported'
}

export type RunRecord = {
  kind: 'reeval-run'
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
  /**
   * What the run planned before it started, and each level whose sandbox ran as root or with
   * capabilities added back.
   */
  plan: {
    evals: number
    cells: number
    attempts: number
    estimateMs: number
    sandboxWarnings: SandboxWarning[]
  }
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
  /** Each pooled `evaluate.each` that ran; unset when none did. */
  families?: FamilyRecord[]
}

/** What ran and graded the agents: the machine, images, harnesses and judge. */
export type Stack = {
  /** The reeval version that wrote the run. */
  reeval: string
  /** `process.versions.node`: under Bun or Deno, the Node version they're compatible with. */
  node: string
  /**
   * The runtime reeval ran on, `node`, `bun`, `deno` or another, and its own version. Absent in
   * runs recorded before it, which ran on Node.
   */
  runtime?: { name: string; version: string }
  /**
   * The language the evals are written in, `typescript` for `*.eval.ts`, and the version of its
   * toolchain when the runner reports one. Absent in runs recorded before it.
   */
  language?: { name: string; version?: string }
  os: string
  arch: string
  /** Every image an attempt started from. `id` is content-addressed; `repoDigests` only exist once pushed. */
  images: Array<AttemptImage & { repoDigests: string[] }>
  /** Exact versions of the packages that run and grade the agent. */
  packages: Record<string, string>
  /**
   * Each harness: its configured `model` and requested `effort`, `resolvedModels` (what it
   * reported serving, with the variant it resolved), and `resolvedEffort` (reasoning-effort
   * suffixes those labels named). Fast (`[fast=true]`) is not `resolvedEffort`.
   */
  harnesses: Array<{
    id: string
    kind: string
    /** The configured model, when the harness has one. */
    model: string | null
    /**
     * The reasoning effort the harness factory asked for; null when it left it unset.
     * Fast is not this.
     */
    effort: string | null
    /**
     * The models the harness reported serving, across every turn in the run, with the variant it
     * resolved (`composer-2.5[fast=true]` for `composer-2.5` with no `params`); empty when it
     * reports none.
     */
    resolvedModels: string[]
    /**
     * Reasoning-effort suffixes those served models named (`medium` from
     * `gpt-5.6-luna[effort=medium]`); empty when they name none. Fast is not this.
     */
    resolvedEffort: string[]
  }>
  /**
   * The run's judge: the config's, with what the profile's `judge` and `defaults.judge` set over it.
   * `config.judgeModel` and `config.threshold` name the same one.
   */
  judge: {
    /** Its model; groups, evals and calls may use others (see each verdict). */
    model: string | null
    /** Model ids the provider reported serving, across every judge call in the run. */
    resolvedModels: string[]
    threshold: number
    /** Changes when reeval, the AI SDK or the provider adapter (and so the judge prompt) change. */
    version: string
    /** What the judge sees by default, every key resolved; absent when the config and profile leave `state` at its defaults. */
    state?: ResolvedJudgeStateOptions
  }
  /** Union of every attempt's context files. */
  context: ContextFile[]
  /** What eval fingerprints hash; fingerprints from different scopes aren't comparable. */
  fingerprintScope: string[]
}

/** The parts of a run's stack that `reeval compare` checks for drift. */
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
  /** Median tool calls, agent time and tokens over the counted attempts; null when none counted. */
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
  /** The run's pooled families; unset when none ran. */
  families?: Array<Pick<FamilyRecord, 'id' | 'name' | 'cases' | 'ran' | 'outcome'>>
}
