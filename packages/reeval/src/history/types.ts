import type {
  AssertionRecord,
  AttemptAnswer,
  AttemptError,
  AttemptImage,
  Cell,
  CellGate,
  CompareAnswer,
  EgressRecord,
  EnvironmentRecord,
  EvalCompareMeta,
  EvalSource,
  ExecTry,
  FileChange,
  JudgeArtifactRef,
  McpStartup,
  Outcome,
  PhaseTimings,
  ResolvedJudgeStateOptions,
  Revision,
  SandboxWarning,
  ServeRecord,
  SetupProcess,
  Snapshot,
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

/** A generic attempt file from `c.capture()`. */
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
  /** Uncommitted changes, outside the `.reeval/` directory and the history folder, when the run started. */
  dirty: boolean
  /** sha256 of the uncommitted changes (tracked and untracked, as a binary patch), when dirty. */
  diffHash: string | null
  /**
   * Those changes are stored as the `worktree.patch` file in the artifact directory. Applying it
   * to `sha` reproduces the workspace.
   */
  worktreePatch: FileRef | null
  /**
   * This explains why a dirty run has no `worktree.patch` file: it was too large, `artifacts` was
   * `'none'`, or it looked like it held a secret (then where, and which rule, never the value).
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

export type JudgmentRecord = {
  question: string
  verdict: 'pass' | 'fail'
  score: number
  threshold: number
  model: string
  /** The model id the provider says served the call, when it reports one. */
  resolvedModel?: string
  /** The gateway from the config's `gateway` list the call went through; unset without one. */
  gateway?: string
  /** The upstream provider the gateway says served the call (OpenRouter's); unset when it names none. */
  upstream?: string
  /** What the gateway says the call cost, in US dollars (OpenRouter's `usage.cost`); unset when it names none. */
  costUsd?: number
  /**
   * `<index>:<sha256(question) prefix>`: the same question at the same place in the evaluation, so a
   * verdict can be followed across runs (and an edited question starts a new series). `<index>`
   * is the call's place among the attempt's `c.judge()` calls, counting calls that failed,
   * whichever finishes first.
   */
  key: string
  /** Transient provider errors retried before this verdict, with the backoff before each retry. */
  retries?: JudgeRetry[]
  /** Captures this call sent the judge as file parts, when any. */
  artifacts?: JudgeArtifactRef[]
}

export type AttemptFiles = {
  /** Each environment setup step's command, exit code, duration, and output. */
  setupLog?: FileRef
  transcript?: FileRef
  /** Unnormalized harness stream parts, only with `REEVAL_RAW_TRANSCRIPT=1`. */
  rawTranscript?: FileRef
  diff?: FileRef
  judgeInput?: FileRef
  /** PNGs from `c.capture()`, under the `artifacts/<name>.png` path. */
  artifacts?: ArtifactRef[]
}

export type ContextFile = { path: string; sha256: string }

/** An upstream provider behind a gateway, and how many of the attempt's calls it served. */
export type UpstreamCount = { provider: string; calls: number }

export type AttemptRecord = {
  /** `<eval key> # <cell key>#<n>`: unique in the run. */
  key: string
  /** `<cell key>#<n>`: unique in its evaluation. */
  id: string
  /** The cell's key; see `EvalEntry.cells`. */
  cell: string
  /** Run number within the cell, from 1. */
  n: number
  /**
   * In a `runs: { bestOf }` cell: `added` when it ran past the majority's first attempts (the
   * earlier ones split, or an infra error left them short), `skipped` when it didn't run because
   * the earlier ones already had a majority. Unset on the attempts that always run.
   */
  bestOf?: 'added' | 'skipped'
  /** Start order across the run, from 1; null for attempts that never started. */
  seq: number | null
  startedAt: string | null
  /** The image the container started from, in `stack.images`; null when the sandbox doesn't start from an image. */
  imageId: string | null
  /** Names of the variables and secrets set in the sandbox, and the brokered ones; never values. */
  env: { vars: string[]; secrets: string[]; brokered: string[] }
  /** Skills, rules, and MCP config visible to the agent in its sandbox, by content hash. */
  context: ContextFile[]
  /** The egress policy and, when the sandbox records it, the hosts contacted and refused; null if it never ran. */
  egress: EgressRecord | null
  /**
   * The models served by the harness's API calls, as observed by the egress gateway. Values may
   * come from requests or responses and include reported effort; null when no model was named or
   * recorded. The gateway reads the request URL for Antigravity, Goose, pi, and OpenCode on a
   * `google/` model, so a request for `<model>-low` records `<model>`, and the API response for
   * Codex, Grok Build, and OpenCode on another provider. Null for Cursor and Claude Code, whose
   * API requests name no model.
   */
  servedModels: string[] | null
  /**
   * The models the harness's successful API calls asked for, when nothing named the one that
   * served them (fx on Vercel AI Gateway with a Gemini model): the agent's word, not the
   * gateway's, so never part of `servedModels`. Absent when there's none.
   */
  askedModels?: string[]
  /**
   * The upstream providers a gateway said served the harness's own API calls (OpenRouter's
   * `provider`), each with how many it served, in the order first seen; more than one means the
   * gateway spread or failed the calls over between them. Absent when the gateway names none.
   */
  upstreams?: UpstreamCount[]
  /**
   * What a gateway said the harness's own API calls cost, in US dollars, summed (OpenRouter's
   * `usage.cost`); absent when it names none.
   */
  reportedCostUsd?: number
  /**
   * The reasoning effort the harness factory asked for (`claudeCode({ effort: 'high' })`);
   * null when the factory left it unset. Fast is not this.
   */
  effort: string | null
  /**
   * The reasoning effort the harness's API said it ran at, from `servedModels` or
   * each turn's `model` (`medium` from `gpt-5.6-luna[effort=medium]`); null when those
   * labels name none. Fast (`[fast=true]`) is not this.
   */
  servedEffort: string | null
  outcome: Outcome
  error: AttemptError | null
  durationMs: number
  /**
   * `text` is the agent's final message, cut at 8 KB; the whole of it is in the `transcript.jsonl`
   * file.
   * `mcpStartup` times each stdio MCP server's start in the turn (`McpStartup`).
   */
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
    /** Each stdio MCP server start during the turn; see `McpStartup`. */
    mcpStartup?: McpStartup[]
  }>
  /** Tokens across the attempt's turns; null when the harness reported none. */
  usage: TokenUsage | null
  /**
   * Tokens the capture vision loop used. Infrastructure only: never included
   * in `usage`, effort, compare, or lift.
   */
  captureUse?: { model: string; moves: number; usage: TokenUsage | null }
  timings: PhaseTimings
  /** Counts from the transcript, so the attempt's activity is available without reading the transcript. `webSearches` includes refused searches. */
  activity: {
    tools: number
    fileEdits: number
    /** Every `web-search` event, including refused ones. Null when a turn with none couldn't report them (`unreported`). */
    webSearches: number | null
    webFetches: number | null
    reasoningMs: number
    /** Transcript tool events with `stalled: true` (long shell or edit). */
    stalledTools: number
    /** Longest tool `durationMs` in the transcript; null when none reported a duration. */
    maxToolMs: number | null
  }
  judgements: JudgmentRecord[]
  /** Harness session starts that didn't become ready within `startTimeout` and were started again (at most one). */
  startRetries?: StartRetry[]
  /**
   * Processes the setup steps left running in a Docker sandbox with a `to: 'checks'` secret
   * without `hosts` in their environment, so they hold its real value while the agent works and
   * the agent, as the same user, can read it from them. Found by the secret's variable name, so a
   * copy under another name or in a command's arguments isn't. At most 20, each
   * `{ command, secrets }`: its command line, masked and cut at 200 characters, and those secrets'
   * names. Absent when there were none.
   */
  setupProcesses?: SetupProcess[]
  /**
   * Copies of the attempt's workspace in its directory in `.reeval/runs` on the machine that ran
   * it (never in the history folder), in the order taken: `turn-<n>` after each `c.send` with
   * `snapshot: 'turns'`, then `final` after the checks. Each has its form, path and size, its
   * file count, the directories left out by name, the files whose secret-looking values were
   * masked and the binary ones left out for holding one, or why it wasn't taken. Absent with
   * `snapshot: false`, and when the sandbox was gone first (a timeout or a cancel).
   */
  snapshots?: Snapshot[]
  /**
   * Each `c.serve` call that listened, in call order: `{ command, port, portEnv, detected,
   * address, readyMs }`. `port` is where it listens; `detected` is true when that isn't the
   * `PORT` it was given (`portEnv`), so reeval found the port from the command's own listening
   * sockets. Absent when the attempt served nothing.
   */
  serves?: ServeRecord[]
  /**
   * Each foreground `c.exec`: its last try's exit code, and `durationMs` over all its tries. With
   * `retries`, `tries` has each try's `{ exitCode, durationMs }` and the log each try's output.
   */
  checks: Array<{
    command: string
    exitCode: number
    durationMs: number
    log?: FileRef
    /** The `retries` it was given, when more than 0: it could run `retries + 1` times. */
    retries?: number
    /** Every try, in order, when it was given `retries`; its log has each try's output. */
    tries?: ExecTry[]
  }>
  /** Every `expect` and `expect.require` matcher call that settled, in call order; unset with none. */
  assertions?: AssertionRecord[]
  /** Files under a dependency directory, such as the `node_modules/` directory or `.venv/` directory, collapse to one entry with `count`. */
  changedFiles: Array<FileChange & { count?: number }>
  files: AttemptFiles
  /**
   * The eval's questions asked of this attempt on its own (those without `across`), in question
   * order; unset without any. They annotate: `outcome` never depends on them. Asked once the
   * attempt ends, when it ran to a pass or a fail. Each answer's `input` is `questions/<n>.json`
   * in the attempt's directory, `<n>` the question's place in the eval's `questions`.
   */
  answers?: AttemptAnswer[]
}

export type EvalEntry = {
  /** `file › group › … › name`, as shown. */
  id: string
  /** Used to match an evaluation across runs; equal to `id`. */
  key: string
  /** Directory name inside the artifact directory, from `key`. */
  slug: string
  file: string
  group: string[]
  name: string
  /** Results are comparable only when fingerprints match. */
  fingerprint: string
  /**
   * The evaluation file, by content hash: where the evaluation lives. Records from before `source`
   * also list the local files it imported, and were fingerprinted over them.
   */
  sources: Array<{ path: string; sha256: string }>
  /**
   * Hashes of what the `sources` fingerprint part covers but `revision`: the eval's body, its
   * case data and its options with its groups'. Unset on records from before it.
   */
  source?: EvalSource
  /** The eval's `revision`, part of the `sources` fingerprint part; unset when it sets none. */
  revision?: Revision
  tags: string[]
  /** The baseline environment, when the evaluation uses `compare`. */
  compare?: EvalCompareMeta
  /**
   * Over gated cells, the outcome is `fail` if any failed, else `infra_error` if any is (a cell is
   * `infra_error` only when nothing counted), else `skipped` if all were, else `pass`. An ungated
   * cell's failures don't fail the evaluation.
   */
  outcome: Outcome
  /** A placeholder, `evaluate.todo` or `group.todo`: it never runs, and its outcome is `skipped`. */
  todo: boolean
  /** pass@1, pass / (pass + fail), over the gated cells' attempts; infra errors and skips excluded. */
  passRate: number | null
  cells: CellRecord[]
  attempts: AttemptRecord[]
  /**
   * The eval's pairwise questions (those with `across`), answered after its attempts by votes,
   * one per question; unset without any. They annotate: `outcome` and `passRate` never depend on them. Each vote
   * may include a short `reason` (capped). `reeval analyze` includes each answer in the digest
   * (rates by cut, votes, ties, a failed call, and a sample of reasons). Each answer's `input` is
   * the `<eval-slug>/questions/<n>.json` file: every call its model was sent, per pair and order,
   * with secrets masked and screenshots as refs; unset where the evaluation's files weren't kept.
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
   * `wilson` or `newcombe-paired`: one counted attempt a case and side, so each case is one
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
  /**
   * `insufficient` below 6 non-zero differences, where the exact test can't reach 0.05. `fewer`
   * and `more` are the test's direction (which side's differences rank higher), not the median's.
   */
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

/** A pooled `evaluate.each`: its cases as samples of one suite. Each case is also an evaluation. */
export type FamilyRecord = {
  /** `file › group › … › template`. */
  id: string
  file: string
  group: string[]
  /** The name template, for example `fixes $id`. */
  name: string
  /** Cases in the list. */
  cases: number
  /** Cases with an evaluation in this run; fewer when a filter or tag left some out. */
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
  /** Over `EvalEntry.source` and `EvalEntry.revision`; on records from before them, over `EvalEntry.sources`. */
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
  /** The gateway its model calls went through; unset on `direct`, each provider's own key. */
  gateway?: string
  /**
   * The cell's gate (`none`, `passRate 0.5`); unset on the default `all`. Compare reads a change
   * in it as a policy change, not a reason the runs can't be compared.
   */
  gate?: string
}

/** One harness and environment of an evaluation, and how its attempts went. */
export type CellRecord = Cell & {
  /** `sha256` of `fingerprintParts`; results are comparable only when it matches. */
  fingerprint: string
  fingerprintParts: FingerprintParts
  /**
   * The environment's digest; null for none. With `environment`, the key into
   * `RunRecord.environments`: environments with the same contents share a digest.
   */
  environmentDigest: string | null
  harnessKind: string
  /**
   * The gateway in the config's `gateway` list its harness resolved to (`direct` is each
   * provider's own key); unset when no config, profile or pin named one.
   */
  gateway?: string
  /** The configured harness model, when it has one. */
  model: string | null
  /**
   * The reasoning effort the harness factory asked for; null when it left it unset.
   * Fast is not this.
   */
  effort: string | null
  /** How the attempts decide the cell's outcome; `'none'` when it doesn't fail the evaluation. */
  gate: CellGate
  /** Environment keys the variant replaced on the control's (or a child on its parent's). */
  overrides: string[]
  /**
   * Set by `runs: { bestOf }`: the cell stopped once a majority of this many attempts agreed, and
   * gates on that majority. `runs` still counts every planned attempt, the skipped ones included.
   */
  bestOf?: number
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
   * Each assertion, by label, seen in any attempt of the evaluation, over this cell's counted
   * attempts; on a variant cell, the control's beside it. Unset when no attempt recorded any.
   */
  checks?: CellCheck[]
}

/** How often one check passed: a counted attempt that never reached it counts it `notRun`. */
export type CheckTally = { pass: number; fail: number; error: number; notRun: number }

/**
 * One check over a cell's counted attempts. `verdict` (variant cells) is `discriminates` when
 * every answered instance passes on one side and fails on the other, `both-pass` when every
 * answered instance passes on both sides, `both-fail` when every answered instance fails on both
 * sides, or `mixed` otherwise. It is absent when either side has no pass or fail.
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
      /** With `bestOf`, the most attempts a cell runs. */
      runs?: number
      /** Set by `defaults.runs: { bestOf }`. */
      bestOf?: number
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
  /**
   * The run's settings. `sandbox` is the id of each sandbox the planned attempts ran on, after the
   * profile's defaults, joined with `, `.
   */
  config: {
    sandbox: string
    environment: string | null
    /**
     * The config's `runs` (with `bestOf`, the most a cell runs); 1 when it sets none, though a
     * compare's cells then run 4 each.
     */
    runs: number
    /** Set by the config's `runs: { bestOf }`. */
    bestOf?: number
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
  /**
   * These are redacted errors outside any attempt: an evaluation file that didn't load, a rejection
   * or throw no attempt awaited, or a worker that died. Any one fails the run. Unset when there
   * were none.
   */
  errors?: string[]
}

/** These fields describe what ran and graded the agents: the machine, images, harnesses, and judge. */
export type Stack = {
  /** The reeval version that wrote the run. */
  reeval: string
  /** `process.versions.node`, or the compatible Node version reported by another runtime. */
  node: string
  /** The runtime reeval ran on, `node`, `bun`, `deno`, or another, and its version. */
  runtime?: { name: string; version: string }
  /**
   * The evaluation language, `typescript` for `*.eval.ts` files, and the version of its toolchain
   * when the runner reports one.
   */
  language?: { name: string; version?: string }
  os: string
  arch: string
  /** Every image an attempt started from. `id` is content-addressed; `repoDigests` exist only after the image is pushed. */
  images: Array<AttemptImage & { repoDigests: string[] }>
  /** Exact versions of the packages that run and grade the agent. */
  packages: Record<string, string>
  /**
   * For each harness, the record includes its configured `model` and requested `effort`,
   * `resolvedModels` (what it reported serving, with the variant it resolved), and
   * `resolvedEffort` (reasoning-effort suffixes those labels named). Fast (`[fast=true]`) is not
   * `resolvedEffort`.
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
     * resolved (`composer-2.5[fast=false]` for `composer-2.5` with no `params`); empty when it
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
    /** The config's default judge inputs, every key resolved. Unset when the config names none, which reeval requires: each `c.judge()` call names its own. */
    state?: ResolvedJudgeStateOptions
  }
  /** Union of every attempt's context files. */
  context: ContextFile[]
  /** What evaluation fingerprints hash; fingerprints from different scopes aren't comparable. */
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
  /** Of `fail`, the attempts the run's interrupt canceled (`error.kind: 'aborted'`); unset when none. */
  canceled?: number
}

/** A family's pooled lift as the history listing keeps it: enough to compare its gate. */
export type FamilyLiftSummary = Pick<FamilyLift, 'variant' | 'vs' | 'points' | 'outcome'> & {
  lo: number
  hi: number
  /** Unset when the compare has no `minLift`, so the lift can't fail. */
  minLift?: number
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
    source?: EvalEntry['source']
    revision?: EvalEntry['revision']
    outcome: Outcome
    passRate: number | null
    cells: HistoryCell[]
  }>
  /** The run's pooled families; unset when none ran. */
  families?: Array<
    Pick<FamilyRecord, 'id' | 'name' | 'cases' | 'ran' | 'outcome'> & {
      /** The eval ids of its cases in this run. */
      caseIds: string[]
      lifts: FamilyLiftSummary[]
    }
  >
  /** The run's errors outside any attempt; unset when there were none. */
  errors?: string[]
}
