import type { ArtifactLevel, JudgeRetry, RecordMode } from './history/types.ts'

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
 * `'provider/model'` (e.g. `'typesafe-ai/jev-1.13.0'`, `'google/gemini-3.8-flash'`), an AI SDK
 * evaluation model object (per group, eval or call only), or a fake judge.
 */
export type JudgeModel = string | FakeJudgeModel | { readonly specificationVersion: string }

/** Merged field by field down the cascade, so per-model settings can join as new fields. */
export type JudgeOptions = {
  model?: JudgeModel
  /** Minimum score (0–1) for a `pass` verdict. */
  threshold?: number
  providerOptions?: Record<string, Record<string, JSONValue>>
  /** The most judge calls to this model's provider at once, across the run. */
  maxConcurrent?: number
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
  /** Which cell of the matrix this attempt is, and its run number (from 1). */
  readonly attempt: { id: string; cell: Cell; n: number }
}
export type EvalFn = (t: EvalContext) => Promise<void>

export type FakeHarnessDescriptor = {
  kind: 'fake'
  /** Cell id; defaults to `fake`. */
  id?: string
  /** Files the fake agent writes into the sandbox on every turn. */
  files?: Record<string, string>
  text?: string
  /** Simulated turn length, honours the abort signal. */
  delayMs?: number
  /** Throw before the first turn starts, to simulate an infra failure. */
  failWith?: string
  /** A reasoning block at the start of every turn. */
  reasoning?: string
  /** Tool calls the fake agent reports on every turn, before writing files. */
  tools?: Array<{ tool: string; input: unknown; output: unknown; ok?: boolean }>
  /** Files and message used instead when the environment gives the agent a skill. */
  withSkill?: { files?: Record<string, string>; text?: string }
  /** Chance (0–1) that an attempt writes no files and says so, for flaky pass rates. */
  flakeRate?: number
  /** The most attempts on this harness kind at once, across the run. */
  maxConcurrent?: number
}
export type CursorHarnessDescriptor = {
  kind: 'cursor'
  model?: string
  /** Cell id; defaults to `cursor:<model>`. */
  id?: string
  /** The most Cursor attempts at once, across the run, e.g. for the account's rate limits. */
  maxConcurrent?: number
}
export type HarnessDescriptor = FakeHarnessDescriptor | CursorHarnessDescriptor

export type FakeSandboxDescriptor = {
  kind: 'fake'
  id?: string
  /** Parent directory for the per-eval workspace (defaults to the OS temp dir). */
  dir?: string
  /** The most attempts on this sandbox kind at once, across the run. */
  maxConcurrent?: number
}
export type DockerSandboxDescriptor = {
  kind: 'docker'
  /** Cell id; defaults to `docker`, or `docker:<image>` for other images. */
  id?: string
  /** An image that already has the harness baked in, used as is. */
  image?: string
  /** A Debian or Ubuntu based toolchain image; ES bakes Node and the harness on top, cached. */
  from?: string
  /** The most Docker sandboxes at once, across the run, whatever their image. */
  maxConcurrent?: number
}
export type SandboxDescriptor = FakeSandboxDescriptor | DockerSandboxDescriptor

/**
 * A host environment variable, redacted everywhere ES writes and recorded by name only. Made by
 * the `secret` helper of `defineEnvironment` and `defineConfig` callbacks.
 */
export type Secret = {
  kind: 'secret'
  /** The host variable; defaults to the key it's set under. */
  from?: string
  /** When the host variable is unset, skip it (the record says so) instead of failing. */
  optional?: boolean
  /** `agent` (default): the container's environment. `checks`: only `t.exec` and `setup` steps. */
  to?: 'agent' | 'checks'
}
/** `secret.template('Bearer ${TOKEN}')`: host variables substituted into a string, for MCP headers. */
export type SecretTemplate = { kind: 'secret-template'; template: string }
export type EnvValue = string | Secret
export type EnvVars = Record<string, EnvValue>

/** A file on the host, read when an attempt starts. Made by the `file` helper. */
export type HostFile = { kind: 'file'; path: string }

export type McpServer =
  | { kind: 'mcp'; transport: 'stdio'; command: string; args: string[]; env: EnvVars }
  | {
      kind: 'mcp'
      transport: 'http' | 'sse'
      url: string
      headers: Record<string, string | Secret | SecretTemplate>
    }

/** `harness` (default): the agent's own skills, via its adapter. `workspace`: its repo skill dir. */
export type SkillPlacement = 'harness' | 'workspace'

export type SkillSource = { kind: 'skill'; placement: SkillPlacement } & (
  | { source: 'local'; path: string; only?: string[]; exclude?: string[] }
  | {
      source: 'git'
      repo: string
      ref?: string
      path?: string
      only?: string[]
      exclude?: string[]
    }
  | { source: 'registry'; id: string; version?: string }
  | { source: 'npm'; spec: string; path: string; only?: string[]; exclude?: string[] }
  | {
      source: 'inline'
      name: string
      description: string
      content: string
      files: Record<string, string>
    }
)

/** Baked into a cached image layer: no secrets, root, cwd `/`. */
export type ImageStep = string | { run: string; timeout?: Duration }
/** Runs in every attempt before the agent starts, with secrets, outside the eval timeout. */
export type SetupStep = { run: string; timeout?: Duration; cwd?: string }

/** What an eval runs in: the declarative, phased spec of one environment. */
export type EnvironmentSpec = {
  image?: ImageStep[]
  env?: EnvVars
  /** Workspace-relative, or `~/` for home. */
  files?: Record<string, string | HostFile>
  /** `AGENTS.md` for the workspace. */
  rules?: string | HostFile
  setup?: SetupStep[]
  skills?: SkillSource[]
  mcp?: Record<string, McpServer>
}

/** One environment in an `extend` chain. */
export type EnvironmentLayer = { name: string; spec: EnvironmentSpec }

/**
 * What an eval runs in: skills, MCP servers, files, rules, variables, secrets and setup. Plain
 * data (`layers` root first), plus a non-enumerable `extend`; see `defineEnvironment`.
 */
export type Environment = {
  readonly kind: 'environment'
  readonly name: string
  readonly layers: readonly EnvironmentLayer[]
  /** A child environment layered on this one; wherever it sets a key this one has, it wins. */
  extend(name: string, spec: EnvironmentInput): Environment
}

/** Typed helpers for environment specs, passed to `defineEnvironment` and `extend` callbacks. */
export type EnvironmentHelpers = {
  secret: SecretHelper
  skill: SkillHelper
  mcp: McpHelper
  /** A host file, relative to the file that calls it (or an absolute path or `URL`). */
  file: (path: string | URL) => HostFile
}

export type SecretHelper = {
  /** The host variable of the same name as the key it's set under. */
  (): Secret
  fromEnv(host: string, options?: { optional?: boolean; to?: 'agent' | 'checks' }): Secret
  template(template: string): SecretTemplate
}

type SkillCommon = { placement?: SkillPlacement }
type SkillDirOptions = SkillCommon & {
  only?: string[]
  /**
   * Paths in each skill directory to leave out of the sandbox, gitignore-style: `*` matches within
   * a name, a leading or inner `/` anchors to the skill root, a trailing `/` matches directories
   * only, and anything else matches a name at any depth. Replaces `DEFAULT_SKILL_EXCLUDE`
   * (`/evals/`, `.history/`, `*.es.ts`); spread it to add to it. `.git` is always left out.
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

/** One value, a list (each is its own cell), or an edit of the inherited list. */
export type HarnessOption =
  | HarnessDescriptor
  | HarnessDescriptor[]
  | ((inherited: HarnessDescriptor[]) => HarnessDescriptor | HarnessDescriptor[])

export type CompareGate = 'variants' | 'all' | 'none'

/** Variants run next to the inherited environment (the control), with the same prompt and checks. */
export type CompareOptions =
  | Environment[]
  | {
      variants: Environment[]
      /** Which cells decide pass/fail: `variants` (default), `all`, or `none` (report only). */
      gate?: CompareGate
      /** Lift in points from -1 to 1; a variant cell below it fails. */
      minLift?: number
      /** Harnesses (ids or descriptors) to compare on; the others run the control only. */
      harness?: Array<string | HarnessDescriptor>
    }
  | false

export type PinnableKey = 'harness' | 'runs' | 'compare'

export type EvalOptions = {
  /** The only list: each harness is its own cell. */
  harness?: HarnessOption
  sandbox?: SandboxDescriptor
  /** What the eval runs in; the control of `compare`. */
  environment?: Environment
  compare?: CompareOptions
  /** Attempts per cell. */
  runs?: number
  /** Variables and secrets for the sandbox, merged by name down the cascade. */
  env?: EnvVars
  judge?: JudgeOptions
  /** Per attempt. */
  timeout?: Duration
  tags?: string[]
  /** Keys a profile's `limit` may not narrow for this group or eval. */
  pin?: PinnableKey[]
}
export type GroupOptions = EvalOptions

/** The config file is plain data sent to workers, so its judge model can't be an object. */
export type ConfigJudgeOptions = Omit<JudgeOptions, 'model'> & { model?: string | FakeJudgeModel }

export type HistoryConfig = {
  /** Committed history folder (default: `.history` in the directory the evals live in). */
  dir?: string
  /** Artifacts recorded next to each run: every eval's, failing evals' only, or none. */
  artifacts?: ArtifactLevel
}

/** Run-level caps. `attempts` is checked against the plan; `duration` while running. */
export type Budget = { attempts?: number; duration?: Duration }

/** What evals get when they don't say otherwise: under groups and evals. */
export type ProfileDefaults = {
  harness?: HarnessDescriptor | HarnessDescriptor[]
  sandbox?: SandboxDescriptor
  environment?: Environment
  runs?: number
  env?: EnvVars
  judge?: ConfigJudgeOptions
  timeout?: Duration
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

/** How a run is sized: chosen with `--profile`, `ES_PROFILE` or `defaultProfile`. */
export type Profile = {
  defaults?: ProfileDefaults
  limit?: ProfileLimit
  judge?: ConfigJudgeOptions
  budget?: Budget
  record?: RecordMode
  /** Tag filters for this profile, like `--tag` (`'!slow'` excludes). */
  tags?: string[]
}

export type EsConfig = {
  include?: string[]
  harness?: HarnessDescriptor | HarnessDescriptor[]
  sandbox?: SandboxDescriptor
  environment?: Environment
  runs?: number
  env?: EnvVars
  judge?: ConfigJudgeOptions
  timeout?: Duration
  /** How many attempts run at once. `--concurrency` and `ES_CONCURRENCY` override it. */
  concurrency?: number
  /** When runs are copied into the history folder: `es record` only, in CI, or on every run. */
  record?: RecordMode
  history?: HistoryConfig
  budget?: Budget
  profiles?: Record<string, Profile>
  /** The profile when neither `--profile` nor `ES_PROFILE` names one: `ci` when `CI` is set. */
  defaultProfile?: { ci?: string; local?: string }
}

/** What a `defineConfig` callback gets: the environment helpers plus the run's context. */
export type ConfigHelpers = EnvironmentHelpers & {
  /** True when `CI` is set and isn't `false`. */
  ci: boolean
  /** The `es` command that's running, e.g. `run`. */
  command: string
  /** `process.env`. */
  hostEnv: NodeJS.ProcessEnv
  /** The profile named by `--profile` or `ES_PROFILE` (not `defaultProfile`), else undefined. */
  profile: string | undefined
}

/** A profile as the run uses it, with why it was chosen. */
export type ResolvedProfile = {
  name: string
  /** `--profile`, `ES_PROFILE`, `auto: CI is set` or `default`. */
  reason: string
  defaults: ProfileDefaults
  limit: ProfileLimit
  judge: ConfigJudgeOptions
  tags: string[]
  budget: Budget
  record?: RecordMode
}

export type ResolvedConfig = {
  root: string
  include: string[]
  harness: HarnessDescriptor[]
  sandbox: SandboxDescriptor
  environment: Environment | undefined
  runs: number
  env: EnvVars
  judge: ConfigJudgeOptions & { threshold: number }
  timeoutMs: number
  /** The config's own `concurrency`; see `resolveConcurrency` for the run's. */
  concurrency: number | undefined
  record: RecordMode
  history: { dir: string; artifacts: ArtifactLevel }
  budget: Budget
  profiles: Record<string, Profile>
  defaultProfile: { ci?: string; local?: string }
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

export type CellRole = 'control' | 'variant'

/**
 * One cell of an eval: a harness and an environment (`-` for none) on the eval's sandbox. With
 * `compare`, the control runs the inherited environment and each variant runs it extended.
 */
export type Cell = {
  key: string
  harness: string
  environment: string
  sandbox: string
  role: CellRole
  /** The variant's name, for variant cells. */
  variant?: string
}

/** An environment as it was applied, without secret values. */
export type EnvironmentRecord = {
  name: string
  /** The environment this one extends (for a variant cell, the control), else null. */
  parent: string | null
  /** Keys a later layer replaced, e.g. `env.KEY`, `skills.genkit`, `mcp.docs`, `rules`. */
  overrides: string[]
  /** Covers every field except the image id; secret names are included, values never are. */
  digest: string
  image: string[]
  setup: string[]
  skills: Array<{
    name: string
    source: string
    commit: string | null
    sha256: string
    placement: SkillPlacement
    /** Paths left out of the sandbox by `exclude` (directories end in `/`); `.git` isn't listed. */
    excluded: string[]
  }>
  mcp: string[]
  files: Array<{ path: string; sha256: string }>
  vars: string[]
  secrets: string[]
  /** Optional secrets whose host variable was unset, so they weren't injected. */
  unset: string[]
}

export type AttemptImage = { ref: string; id: string; agentCli: string | null }

/** What one judge call saw, and for a call that failed, why and what was retried first. */
export type JudgeInput = {
  question: string
  model: string
  state: { [key: string]: JSONValue }
  error?: string
  retries?: JudgeRetry[]
}

/** Full per-attempt payload, written to disk by the worker. */
export type EvalRecord = {
  outcome: Exclude<Outcome, 'skipped'>
  error: { kind: ErrorKind; message: string } | null
  turns: TurnRecord[]
  /** Workspace changes over the whole eval. */
  diff: Diff | null
  checks: Array<{ command: string; durationMs: number } & ExecResult>
  /** With `retries` when transient provider errors were retried on the way to the verdict. */
  judgements: Array<Verdict & { retries?: JudgeRetry[] }>
  timings: PhaseTimings
  /** Skills, rules and MCP config visible to the agent, by content hash. */
  context?: Array<{ path: string; sha256: string }>
  /** What each judge call saw, in call order, including calls that errored. */
  judgeInputs?: JudgeInput[]
  environment?: EnvironmentRecord
  image?: AttemptImage | null
  /** Names of the variables and secrets set in the sandbox. */
  env?: { vars: string[]; secrets: string[] }
  /** The environment's setup steps as they ran, output redacted later. */
  setup?: Array<{ run: string; exitCode: number | null; durationMs: number; output: string }>
}

/** How an eval was sized for the plan: what it asked for, and what a profile changed. */
export type EvalPlan = {
  harnesses: number
  /** Variants run, of those the eval compares; null without `compare`. */
  variants: { run: number; of: number } | null
  runs: number
  attempts: number
  notes: string[]
  /** Why the eval doesn't run at all, e.g. a profile's harness limit left none. */
  skip?: string
  /** Warnings about the eval's setup, e.g. a moving git ref. */
  warnings: string[]
}

/** Set when an attempt is registered, so the reporter has it even for skipped attempts. */
export type AttemptMeta = {
  name: string
  groups: string[]
  tags: string[]
  cell: Cell
  n: number
  /** The harness, then the role (with `compare`), plus `#n` when it has several runs. */
  label: string
  harness: HarnessDescriptor
  sandbox: SandboxDescriptor
  /** Whether this attempt's failures fail the run; controls aren't, by default. */
  gated: boolean
  /** Set on variant attempts whose compare has a `minLift`. */
  minLift?: number
  plan: EvalPlan
}

/** Small summary carried through the engine's task metadata. */
export type EvalMeta = {
  outcome: EvalRecord['outcome']
  errorKind: ErrorKind | null
  judgements: Array<Pick<Verdict, 'verdict' | 'score' | 'threshold'> & { question: string }>
}

export type RunContext = {
  runId: string
  stagingDir: string
  config: ResolvedConfig
  /** `es run --runs n`: overrides every level. */
  runs?: number
  /** `es run --tag` and the profile's tags: each is a tag, or `!tag` to exclude; all must hold. */
  tags: string[]
  /** How many attempts run at once, across the run. */
  concurrency: number
  profile: ResolvedProfile | null
}
