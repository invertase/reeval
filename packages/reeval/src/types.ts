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
    /** A step that failed while the turn went on: a model call the harness retried. */
    | { type: 'retry'; message: string }
  )

/** The transcript events a harness may be unable to report. */
export type WebEventType = 'web-search' | 'web-fetch'

export type ExecResult = { exitCode: number; stdout: string; stderr: string }

export type FileChange = { path: string; status: 'added' | 'modified' | 'deleted' }
export type Diff = { patch: string; files: FileChange[] }

export type TurnStatus = 'completed' | 'aborted' | 'error'

/**
 * The tokens one turn used, as its harness reported them. `input` excludes cache reads and
 * writes (so the prompt was `input + cacheRead + cacheWrite`); `reasoning` is part of `output`.
 */
export type TokenUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number | null
}

/** One agent turn. Immutable once `t.send()` resolves. */
/** A turn as data, as a record or another language's runner carries it: `Turn` without its methods. */
export type TurnData = {
  prompt: string
  /** The agent's final message for this turn. */
  text: string
  status: TurnStatus
  startedAt: string
  durationMs: number
  transcript: TranscriptEvent[]
  /** Tokens the turn used; null when the harness reports none. */
  usage: TokenUsage | null
  /**
   * The model the harness says served the turn, e.g. `composer-2.5[fast=false]`; null when it
   * reports none. It can differ from the requested one (an alias, or parameters it filled in).
   */
  model: string | null
  /**
   * Event types the harness couldn't report for this turn: the agent may have searched or
   * fetched with no event in `transcript`. `toHaveSearched()` and `toHaveFetched()` refuse such a
   * turn. Usually `[]`; a Cursor turn whose web calls the adapter couldn't recover (its SDK drops
   * them from the stream) is `['web-search', 'web-fetch']`.
   */
  unreported: WebEventType[]
  /** Workspace changes since the eval started, as of the end of this turn. */
  diff: Diff
}

export type Turn = TurnData & {
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

/** A canned judge for tests and dry runs; see `fakeJudge()` in `reeval/judge`. */
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
  /** Workspace-relative, or `~/` for the home directory; `null` when there's no such file. */
  readFile(path: string): Promise<string | null>
  /**
   * Starts the sandbox and the agent session without a turn, for checks on what the environment
   * set up. `t.send()` starts them too; calling both starts them once.
   */
  sandbox(): Promise<Pick<EvalContext, 'exec' | 'readFile'>>
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
  /** Sits out `delayMs` even after an abort, like an agent that doesn't stop when it's told to. */
  ignoreAbort?: boolean
  /** Throw before the first turn starts, to simulate an infra failure. */
  failWith?: string
  /** The first this many session starts of an attempt never become ready, even when aborted (`true`: every one). */
  startHangs?: number | true
  /** A reasoning block at the start of every turn. */
  reasoning?: string
  /**
   * The model the fake agent says served each turn, as a real harness reports its resolved model
   * and variant (`composer-2.5[fast=true]`); unset, it reports none.
   */
  servedModel?: string
  /** Tool calls the fake agent reports on every turn, before writing files. */
  tools?: Array<{ tool: string; input: unknown; output: unknown; ok?: boolean }>
  /** Files and message used instead when the environment gives the agent a skill. */
  withSkill?: { files?: Record<string, string>; text?: string }
  /** Chance (0–1) that an attempt writes no files and says so, for flaky pass rates. */
  flakeRate?: number
  /**
   * Real sandbox actions, one list per `t.send` (the last list repeats), run in order before
   * `files`. `exec` runs as the agent: with the sandbox's own variables, none of the checks'.
   */
  script?: FakeScriptStep[][]
  /** The most attempts on this harness kind at once, across the run. */
  maxConcurrent?: number
  /**
   * How long the harness's session may take to become ready (its bootstrap and first session)
   * before the attempt is an infra error, after one retry; default 90s.
   */
  startTimeout?: Duration
  /**
   * Behave like this agent: its image, and where it reads rules and skills (`CLAUDE.md` and
   * `.claude/skills` for `claude-code`, `~/.gemini/config/skills` for `antigravity`,
   * `~/.config/opencode/skills` for `opencode`, Goose's private home for `goose`,
   * `~/.pi/agent/skills` for `pi`, `~/.agents/skills` for `codex`). Defaults to the
   * fake's own (`AGENTS.md`, `.agents/skills`) in Cursor's image.
   */
  layout?: 'cursor' | 'claude-code' | 'antigravity' | 'opencode' | 'goose' | 'pi' | 'codex'
}
/**
 * One action of a scripted fake agent. `exec` is reported as a `shell` tool call whose output is
 * the command's stdout, `write` as file edits, and `reply` is the turn's final message. `mcp`
 * (`'<server>/<tool>'`) starts the environment's stdio MCP server in the sandbox, as an agent
 * would, and calls the tool with no arguments; it's reported as `mcp__<server>__<tool>`.
 * `error` ends the turn there with status `error` and that message, as a provider error would.
 */
export type FakeScriptStep =
  | { exec: string }
  | { write: Record<string, string> }
  | { reply: string }
  | { mcp: string }
  | { error: string }
/**
 * Cursor's agent through the Cursor TypeScript SDK's local runtime
 * (`@reeval/harness-cursor-sdk`), made by `cursor()`. It reports each turn's tokens.
 */
export type CursorHarnessDescriptor = {
  kind: 'cursor'
  /** A model id `Cursor.models.list()` returns for the key, e.g. `composer-2.5`. */
  model: string
  /**
   * Model parameters, e.g. `{ fast: 'false' }`. Unset ones take the default variant in Cursor's
   * model catalog (`fast=true` for `composer-2.5`), sent explicitly; pass the ones that change cost.
   */
  params?: Record<string, string>
  /** Cell id; defaults to `cursor:<model>`. */
  id?: string
  /** The most Cursor attempts at once, across the run, e.g. for the account's rate limits. */
  maxConcurrent?: number
  /**
   * How long the harness's session may take to become ready (its bootstrap and first session)
   * before the attempt is an infra error, after one retry; default 90s.
   */
  startTimeout?: Duration
}
/** Claude Code through `@ai-sdk/harness-claude-code`, made by `claudeCode()`. */
export type ClaudeCodeHarnessDescriptor = {
  kind: 'claude-code'
  /** A model id or alias the `claude` CLI accepts, e.g. `claude-sonnet-5` or `sonnet`. */
  model: string
  /** Cell id; defaults to `claude-code:<model>`. */
  id?: string
  /** The most Claude Code attempts at once, across the run, e.g. for the account's rate limits. */
  maxConcurrent?: number
  /**
   * How long the harness's session may take to become ready (its bootstrap and first session)
   * before the attempt is an infra error, after one retry; default 90s.
   */
  startTimeout?: Duration
}
/** The Antigravity CLI through `@reeval/harness-antigravity`, made by `antigravity()`. */
export type AntigravityHarnessDescriptor = {
  kind: 'antigravity'
  /** A model slug `agy models` lists for a Gemini API key, e.g. `gemini-3.8-flash-medium`. */
  model: string
  /** Cell id; defaults to `antigravity:<model>`. */
  id?: string
  /** The most Antigravity attempts at once, across the run, e.g. for the key's rate limits. */
  maxConcurrent?: number
  /**
   * How long the harness's session may take to become ready (its bootstrap and first session)
   * before the attempt is an infra error, after one retry; default 90s.
   */
  startTimeout?: Duration
}
/**
 * OpenCode through `@reeval/harness-opencode` (`opencode acp`), made by `opencode()`. It runs
 * on any provider whose key OpenCode sends in a header on known hosts, with that provider's key,
 * and reports no usage (its ACP server counts one call).
 */
export type OpenCodeHarnessDescriptor = {
  kind: 'opencode'
  /**
   * OpenCode's model id, `<provider>/<model>`, e.g. `google/gemini-3.8-flash` or
   * `anthropic/claude-haiku-4-5`; the provider picks the key.
   */
  model: string
  /** Cell id; defaults to `opencode:<model>`. */
  id?: string
  /** The most OpenCode attempts at once, across the run, e.g. for the key's rate limits. */
  maxConcurrent?: number
  /**
   * How long the harness's session may take to become ready (its bootstrap and first session)
   * before the attempt is an infra error, after one retry; default 90s.
   */
  startTimeout?: Duration
}
/**
 * Goose through `@reeval/harness-goose` (`goose acp`), made by `goose()`. It runs Google models
 * on a Gemini API key, and reports no usage (its ACP server counts one call).
 */
export type GooseHarnessDescriptor = {
  kind: 'goose'
  /** A Gemini model id, run on Goose's `google` provider, e.g. `gemini-3.8-flash`. */
  model: string
  /** Cell id; defaults to `goose:<model>`. */
  id?: string
  /** The most Goose attempts at once, across the run, e.g. for the key's rate limits. */
  maxConcurrent?: number
  /**
   * How long the harness's session may take to become ready (its bootstrap and first session)
   * before the attempt is an infra error, after one retry; default 90s.
   */
  startTimeout?: Duration
}
/**
 * pi through `@reeval/harness-pi` (`pi --mode json` in the sandbox), made by `pi()`. It runs
 * Google models on a Gemini API key and reports each model call's tokens. It takes stdio and
 * HTTP MCP servers, not SSE ones.
 */
export type PiHarnessDescriptor = {
  kind: 'pi'
  /** A Gemini model id, run on pi's `google` provider, e.g. `gemini-3.8-flash`. */
  model: string
  /** Cell id; defaults to `pi:<model>`. */
  id?: string
  /** The most pi attempts at once, across the run, e.g. for the key's rate limits. */
  maxConcurrent?: number
  /**
   * How long the harness's session may take to become ready (its bootstrap and first session)
   * before the attempt is an infra error, after one retry; default 90s.
   */
  startTimeout?: Duration
}
/**
 * OpenAI's Codex CLI through `@reeval/harness-codex` (`codex exec --json`), made by `codex()`.
 * It runs OpenAI models on an OpenAI API key and reports each turn's tokens, reasoning included.
 */
export type CodexHarnessDescriptor = {
  kind: 'codex'
  /** An OpenAI model id Codex runs on the Responses API, e.g. `gpt-5.6-luna`. */
  model: string
  /** Cell id; defaults to `codex:<model>`. */
  id?: string
  /** The most Codex attempts at once, across the run, e.g. for the key's rate limits. */
  maxConcurrent?: number
  /**
   * How long the harness's session may take to become ready (its bootstrap and first session)
   * before the attempt is an infra error, after one retry; default 90s.
   */
  startTimeout?: Duration
}
/** A real coding agent, driven through its AI SDK harness adapter. */
export type AgentHarnessDescriptor =
  | CursorHarnessDescriptor
  | ClaudeCodeHarnessDescriptor
  | AntigravityHarnessDescriptor
  | OpenCodeHarnessDescriptor
  | GooseHarnessDescriptor
  | PiHarnessDescriptor
  | CodexHarnessDescriptor
export type HarnessDescriptor = FakeHarnessDescriptor | AgentHarnessDescriptor

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
  /** A Debian or Ubuntu based toolchain image; reeval bakes Node and the harness on top, cached. */
  from?: string
  /**
   * An absolute path to a Dockerfile (`docker()` resolves it against the calling file), built from
   * its directory with `REEVAL_BASE` set to reeval's sandbox image and cached by content hash.
   */
  dockerfile?: string
  /** Baked onto the sandbox image in one build container: in order, no secrets, no workspace. */
  install?: InstallStep[]
  /** The most Docker sandboxes at once, across the run, whatever their image. */
  maxConcurrent?: number
  /**
   * Run the agent, setup steps and checks as root, with the capabilities `apt-get` needs, instead
   * of the unprivileged `reeval` user. For evals that install system packages at run time.
   */
  root?: boolean
  /** Linux capabilities to add back, e.g. `['NET_RAW']`; every other one is dropped. */
  capabilities?: string[]
  /** The container's memory, with no swap on top: `'4g'` (default), `'512m'`, or bytes. */
  memory?: string | number
  /** CPUs the container may use, fractions allowed. Default 2, capped at the Docker host's. */
  cpus?: number
  /** Processes and threads at once. Default 1024. */
  pids?: number
}
export type SandboxDescriptor = FakeSandboxDescriptor | DockerSandboxDescriptor

/**
 * A host environment variable, redacted everywhere reeval writes and recorded by name only. Made by
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
  /**
   * Brokers the secret: the sandbox gets a per-attempt placeholder, and the Docker egress gateway
   * swaps in the real value only on HTTPS requests to these hosts (`*.example.com` for subdomains).
   */
  hosts?: string[]
  /** Where in a request to those hosts the gateway substitutes; defaults to `['header']`. */
  in?: SubstituteIn[]
}
/** `header` values, the `query` string, or the request `body`. */
export type SubstituteIn = 'header' | 'query' | 'body'
export type SecretOptions = {
  optional?: boolean
  to?: 'agent' | 'checks'
  hosts?: readonly string[]
  in?: readonly SubstituteIn[]
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

/** A `docker({ install })` command, baked into a cached image layer: no secrets, root, cwd `/`. */
export type InstallStep = string | { run: string; timeout?: Duration }
/** Runs in every attempt before the agent starts, with secrets, outside the eval timeout. */
/** A shell command, or `{ run, timeout?, cwd? }`; `cwd` is relative to the workspace or absolute. */
export type SetupStep = string | { run: string; timeout?: Duration; cwd?: string }

/**
 * Where the sandbox may connect: anywhere (`'allow-all'`, the default), nowhere (`'deny-all'`), or
 * only the listed hosts (`'*.example.com'` matches subdomains). Under a restricted policy the
 * harness's own hosts, brokered secrets' `hosts` and MCP servers' hosts are allowed too; any
 * other request gets a refusal, and the attempt goes on.
 */
export type EgressPolicy = 'allow-all' | 'deny-all' | { allow: readonly string[] }

/**
 * A git repository (or one directory of it) the workspace starts as, from the `git` helper. `url`
 * is what reeval fetches: the clone URL, or an absolute path for a local repository.
 */
export type GitWorkspace = {
  kind: 'git'
  /** As written: a URL, `github:owner/repo`, or a local path. */
  repo: string
  url: string
  /** A branch, tag or commit SHA; unset is the remote's `HEAD`. */
  ref?: string
  /** A directory in the repository whose contents become the workspace. */
  path?: string
  /** Give the workspace a `.git`: one commit of the fetched tree, with no remote. */
  init?: boolean
  /** The host variable holding a token for the fetch; read on the host only. */
  token?: string
}

export type GitHelper = (
  repo: string | URL,
  options?: { ref?: string; path?: string; init?: boolean; token?: string },
) => GitWorkspace

/** What an eval runs in: the declarative, phased spec of one environment. */
export type EnvironmentSpec = {
  /** The code the workspace starts as, before `files`, `rules` and `setup`; a child's replaces its parent's. */
  workspace?: GitWorkspace
  env?: EnvVars
  /** Replaces the inherited policy; an `extend` child's replaces its parent's. */
  egress?: EgressPolicy
  /** Workspace-relative, or `~/` for home. */
  files?: Record<string, string | HostFile>
  /** Project rules, written where the harness's agent reads them: `AGENTS.md`, or `CLAUDE.md` for Claude Code. */
  rules?: string | HostFile
  setup?: SetupStep[]
  skills?: SkillSource[]
  mcp?: Record<string, McpServer>
}

/** One environment in an `extend` chain. */
export type EnvironmentLayer = { name: string; spec: EnvironmentSpec }

/**
 * What an eval runs in: skills, MCP servers, files, rules, variables, secrets and setup. Plain
 * data (`layers` root first), plus a non-enumerable `extendEnvironment`; see `defineEnvironment`.
 */
export type Environment = {
  readonly kind: 'environment'
  readonly name: string
  readonly layers: readonly EnvironmentLayer[]
  /**
   * A child environment layered on this one; wherever it sets a key this one has, it wins.
   * This is how two `compare` arms share setup: `compare` itself never layers.
   */
  extendEnvironment(name: string, spec: EnvironmentInput): Environment
}

/** Typed helpers for environment specs, passed to `defineEnvironment` and `extend` callbacks. */
export type EnvironmentHelpers = {
  secret: SecretHelper
  skill: SkillHelper
  mcp: McpHelper
  /** A host file, relative to the file that calls it (or an absolute path or `URL`). */
  file: (path: string | URL) => HostFile
  /** A git repository for `workspace`: a URL, `github:owner/repo`, or a local path. */
  git: GitHelper
}

export type SecretHelper = {
  /** The host variable of the same name as the key it's set under. */
  (options?: SecretOptions): Secret
  fromEnv(host: string, options?: SecretOptions): Secret
  template(template: string): SecretTemplate
  /** The hosts well-known APIs take their keys on, for `hosts`. */
  hosts: {
    readonly gemini: readonly string[]
    readonly openai: readonly string[]
    readonly anthropic: readonly string[]
    readonly github: readonly string[]
  }
}

type SkillCommon = { placement?: SkillPlacement }
type SkillDirOptions = SkillCommon & {
  only?: string[]
  /**
   * Paths in each skill directory to leave out of the sandbox, gitignore-style: `*` matches within
   * a name, a leading or inner `/` anchors to the skill root, a trailing `/` matches directories
   * only, and anything else matches a name at any depth. Replaces `DEFAULT_SKILL_EXCLUDE`
   * (`/evals/`, `.history/`, `*.eval.ts`); spread it to add to it. `.git` is always left out.
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

/**
 * An edit of the inherited harness list, as data: `add` appends harnesses, `only` keeps the
 * inherited ones with these ids, in their order.
 */
export type HarnessEdit =
  | { add: HarnessDescriptor | HarnessDescriptor[] }
  | { only: string | string[] }

/** One value, a list (each is its own cell), or an edit of the inherited list, as data. */
export type HarnessData = HarnessDescriptor | HarnessDescriptor[] | HarnessEdit

/** `HarnessData`, or a function that edits the inherited list (TypeScript only). */
export type HarnessOption =
  | HarnessData
  | ((inherited: HarnessDescriptor[]) => HarnessDescriptor | HarnessDescriptor[])

export type CompareGate = 'variants' | 'all' | 'none'

/**
 * The baseline and each variant run as their own environments, with the same prompt and checks.
 * `compare` does not layer them. Share setup first with `environment.extendEnvironment`.
 * `false` is not a value here: a profile turns compare off with `limit.compare`.
 */
export type CompareOptions<E = Environment> = {
  /** The control. Not layered under the variants, and not the eval's `environment`. */
  baseline: E
  /** Other environments, each planned and run as itself. */
  variants: E[]
  /** Which cells decide pass/fail: `variants` (default), `all`, or `none` (report only). */
  gate?: CompareGate
  /** Lift in points from -1 to 1; a variant cell below it fails. */
  minLift?: number
  /** Harnesses (ids or descriptors) to compare on; the others run the control only. */
  harness?: Array<string | HarnessDescriptor>
  /**
   * Asked of pairs of attempts after the run, one question or several. They annotate the
   * compare with win rates and never change pass, fail or the exit code.
   */
  question?: CompareQuestion | CompareQuestion[]
}

/**
 * A question for pairwise judgement: its text, or the text and the `'provider/model'` that
 * answers it. Without a model, `analysis.model` answers, else the judge's when it's a language model.
 */
export type CompareQuestion = string | { question: string; model?: string }

/** A compare question as planned: its text, and the model it names itself, if any. */
export type PlannedQuestion = { question: string; model?: string }

/** Which pairs a vote is over: two arms on one harness, or two harnesses on one arm. */
export type CompareCut = 'within' | 'across'

/** One judgement of one pair of attempts, in one order. */
export type PairVote = {
  question: string
  cut: CompareCut
  /** Set on a within-harness pair: the harness both arms ran on. */
  harness?: string
  /** Set on a cross-harness pair: the arm (environment) both harnesses ran. */
  arm?: string
  /** The run number both attempts share, from 1. */
  run: number
  /** The two sides by name: arms within a harness, harness ids across. */
  a: string
  b: string
  /** `a`, `b` or `'tie'`, mapped back from the blinded labels. */
  winner: string | 'tie'
  /** True for the repeat that showed `b` first. */
  swapped: boolean
}

/** A compare question's answer: every vote, and each side's wins over decided votes per cut. */
export type CompareAnswer = {
  question: string
  /** `'provider/model'`, or `fake` for `fakeAnalysis()`. */
  model: string
  /** The model id the provider says served the calls, when it reports one. */
  resolvedModel?: string
  votes: PairVote[]
  /** Wins over decided pairs, per named side, per cut. */
  rates: Array<{ cut: CompareCut; name: string; wins: number; n: number }>
  /** Why some or all of its votes are missing: the model call failed. Outcomes never change. */
  error?: string
}

export type PinnableKey = 'harness' | 'runs' | 'compare'

/**
 * How a cell's attempts decide its outcome: `'all'` (the default) passes only when every attempt
 * passes; `{ passRate }` passes when at least that share of its passes and fails are passes.
 */
export type GatePolicy = 'all' | { passRate: number }

/** A cell's gate: its policy, or `'none'` when its failures don't fail the eval (a control's). */
export type CellGate = GatePolicy | 'none'

/** A compare object: `baseline` and `variants`. Same as `CompareOptions`. */
export type CompareSpec<E = Environment> = CompareOptions<E>

/** Options other than `environment` and `compare`, which are exclusive of each other. */
type EvalOptionFields = {
  /** The only list: each harness is its own cell. */
  harness?: HarnessOption
  sandbox?: SandboxDescriptor
  /** Attempts per cell. */
  runs?: number
  /** How each cell's attempts decide its outcome; default `'all'`. */
  gate?: GatePolicy
  /** Variables and secrets for the sandbox, merged by name down the cascade. */
  env?: EnvVars
  /**
   * Where the sandbox may connect. Replaces the inherited policy: config, profile defaults, the
   * environment, then groups and the eval.
   */
  egress?: EgressPolicy
  judge?: JudgeOptions
  /** Per attempt. */
  timeout?: Duration
  tags?: string[]
  /** Keys a profile's `limit` may not narrow for this group or eval. */
  pin?: PinnableKey[]
}

/**
 * One or the other. `compare: false` is not an option here: a profile's `limit.compare: false`
 * strips variants. A parent `environment` and a child that only sets `compare` are two objects,
 * so that cascade is allowed; the inherited environment is not applied.
 */
type EnvironmentOrCompare<E> =
  | {
      /** What this group or eval runs in. Not together with `compare`. */
      environment?: E
      compare?: never
    }
  | {
      /** Forbidden beside `compare`. The compare object names every arm. */
      environment?: never
      compare: CompareSpec<E>
    }

export type EvalOptions = EvalOptionFields & EnvironmentOrCompare<Environment>
export type GroupOptions = EvalOptions

/**
 * `EvalOptions` in their data forms, as JSON carries them: the harness as data, the judge's model
 * by name or a fake judge, and environments without `extend`. The same `environment` / compare
 * object split as `EvalOptions`.
 */
export type EvalOptionsData = Omit<EvalOptionFields, 'harness' | 'judge'> & {
  harness?: HarnessData
  judge?: ConfigJudgeOptions
} & EnvironmentOrCompare<EnvironmentData>

/** An `Environment` as data, as JSON carries it: without `extendEnvironment`. */
export type EnvironmentData = Omit<Environment, 'extendEnvironment'>

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
  gate?: GatePolicy
  env?: EnvVars
  egress?: EgressPolicy
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

/** How a run is sized: chosen with `--profile`, `REEVAL_PROFILE` or `defaultProfile`. */
export type Profile = {
  defaults?: ProfileDefaults
  limit?: ProfileLimit
  judge?: ConfigJudgeOptions
  budget?: Budget
  record?: RecordMode
  /** Tag filters for this profile, like `--tag` (`'!slow'` excludes). */
  tags?: string[]
}

/** What a fake note is written from: the eval, the harness, and what its tools returned. */
export type FakeNoteInput = {
  eval: string
  harness: string
  attempts: Array<{ id: string; outcome: string }>
  /** Each failed attempt the fake opened beside a passing one, and the step where they diverged. */
  compared: Array<{ failed: string; passed: string; divergedAt: number | null }>
}

/** A canned analysis for tests; see `fakeAnalysis()` in `reeval/judge`. */
export type FakeAnalysisModel = {
  kind: 'fake-analysis'
  /** The model's structured answer, or a function of the digest it was given. */
  output?: unknown | ((digest: unknown) => unknown)
  /** `analysis.agent`'s note on each eval and harness: text, a function of its tools' results, or an error to throw. */
  note?: string | ((input: FakeNoteInput) => string) | { error: string }
  /**
   * How it answers compare questions: a fixed pick, a function of the blinded pair, or
   * `{ error }` to fail every call. Default `'tie'`.
   */
  vote?: FakeVote | ((pair: BlindPair) => FakeVote) | { error: string }
}

/** A blinded label's pick: the attempt shown first (`A`), second (`B`), or neither. */
export type FakeVote = 'A' | 'B' | 'tie'

/** What a compare question's model is shown: the prompt, and the two diffs in slot order. */
export type BlindPair = { question: string; prompt: string; a: string; b: string }

/** `reeval analyze`: a language model (not an evaluation model) and what matters in this project. */
export type AnalysisConfig = {
  /** `'provider/model'`, e.g. `'google/gemini-3.8-flash'`; default: the judge's, if it's one. */
  model?: string | FakeAnalysisModel
  /**
   * `reeval run` writes a note on each eval and harness once its attempts finish, with the analysis
   * model (default false: one call per eval and harness, every run).
   */
  agent?: boolean
  /** Added to the prompt, e.g. "Fewer tool calls count as a win. The skill under test is reeval-good." */
  instructions?: string
  /** The digest's cap; evidence is dropped, lowest priority first, to fit (default 20000). */
  maxInputTokens?: number
  /** The most tokens the model may answer with (default 8000). reeval has no prices, so tokens are the cap. */
  maxOutputTokens?: number
}

export type EsConfig = {
  include?: string[]
  harness?: HarnessDescriptor | HarnessDescriptor[]
  sandbox?: SandboxDescriptor
  environment?: Environment
  runs?: number
  /** How each cell's attempts decide its outcome; default `'all'`. */
  gate?: GatePolicy
  env?: EnvVars
  egress?: EgressPolicy
  judge?: ConfigJudgeOptions
  timeout?: Duration
  /** How many attempts run at once. `--concurrency` and `REEVAL_CONCURRENCY` override it. */
  concurrency?: number
  /** When runs are copied into the history folder: `reeval record` only, in CI, or on every run. */
  record?: RecordMode
  history?: HistoryConfig
  budget?: Budget
  profiles?: Record<string, Profile>
  /** The profile when neither `--profile` nor `REEVAL_PROFILE` names one: `ci` when `CI` is set. */
  defaultProfile?: { ci?: string; local?: string }
  /** `unbrokered: 'error'` refuses Docker secrets without `hosts` instead of warning (default `'warn'`). */
  secrets?: { unbrokered?: 'warn' | 'error' }
  /**
   * Local debug data in `.reeval/debug`: how many runs to keep (default 20), and how many MB of raw
   * trace each attempt buffers for trace.ndjson (default 8; the oldest entries go first).
   */
  debug?: { keep?: number; traceBufferMb?: number }
  analysis?: AnalysisConfig
}

/** What a `defineConfig` callback gets: the environment helpers plus the run's context. */
export type ConfigHelpers = EnvironmentHelpers & {
  /** True when `CI` is set and isn't `false`. */
  ci: boolean
  /** The `reeval` command that's running, e.g. `run`. */
  command: string
  /** `process.env`. */
  hostEnv: NodeJS.ProcessEnv
  /** The profile named by `--profile` or `REEVAL_PROFILE` (not `defaultProfile`), else undefined. */
  profile: string | undefined
}

/** A profile as the run uses it, with why it was chosen. */
export type ResolvedProfile = {
  name: string
  /** `--profile`, `REEVAL_PROFILE`, `auto: CI is set` or `default`. */
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
  /** The config file as typed from the current directory, or `reeval.config.ts` without one. */
  file: string
  /** The keys the config sets, for `reeval report`'s config shape. */
  optionKeys?: string[]
  include: string[]
  harness: HarnessDescriptor[]
  sandbox: SandboxDescriptor
  environment: Environment | undefined
  runs: number
  /** Unset means `'all'`; kept unset so the plan can hint when `runs > 1`. */
  gate: GatePolicy | undefined
  env: EnvVars
  egress?: EgressPolicy
  judge: ConfigJudgeOptions & { threshold: number }
  timeoutMs: number
  /** The config's own `concurrency`; see `resolveConcurrency` for the run's. */
  concurrency: number | undefined
  record: RecordMode
  history: { dir: string; artifacts: ArtifactLevel }
  budget: Budget
  profiles: Record<string, Profile>
  defaultProfile: { ci?: string; local?: string }
  secrets: { unbrokered: 'warn' | 'error' }
  debug: { keep: number; traceBufferBytes: number }
  analysis: AnalysisConfig & { maxInputTokens: number; maxOutputTokens: number }
}

export type Outcome = 'pass' | 'fail' | 'infra_error' | 'skipped'
export type ErrorKind = 'assertion' | 'timeout' | 'aborted' | 'infra' | 'judge'

/**
 * The sandbox an attempt needed that couldn't be prepared before the run, on each attempt that
 * needed it: its provider's stage (Docker's `image`, `from`, `dockerfile`, `harness` or
 * `install`, or `workspace` for a git workspace, whose `ref` is `repo#ref:path`), what was being
 * made, the class (`config`, `transient` after the retries, or `resource`), a named cause
 * (`enospc`, `oom`), the build log, and the levels that set it.
 */
export type PrepareFailureRecord = {
  class: 'config' | 'transient' | 'resource'
  stage: string
  ref: string | null
  cause: 'enospc' | 'oom' | null
  log: string | null
  setBy: string[]
}

/** Why an attempt failed; `prepare` when its sandbox couldn't be prepared. */
export type AttemptError = { kind: ErrorKind; message: string; prepare?: PrepareFailureRecord }

export type TurnRecord = Pick<
  Turn,
  | 'prompt'
  | 'text'
  | 'status'
  | 'transcript'
  | 'startedAt'
  | 'durationMs'
  | 'usage'
  | 'model'
  | 'unreported'
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
 * `compare`, the control is `baseline` and each variant is that environment on its own.
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
  /** The previous `extendEnvironment` layer's name, else null. */
  parent: string | null
  /** Keys a later layer replaced, e.g. `env.KEY`, `skills.genkit`, `mcp.docs`, `rules`. */
  overrides: string[]
  /** Covers every field but the rules file's path; secret names are included, values never are. The image is the sandbox's. */
  digest: string
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
  /** Secrets the sandbox only had placeholders for, swapped in by the egress gateway. */
  brokered: string[]
  /** Optional secrets whose host variable was unset, so they weren't injected. */
  unset: string[]
  /** The policy the attempt ran under, from the options and the environment; in the digest unless `allow-all`. */
  egress: EgressPolicy
  /**
   * The git repository the workspace started as: the repo as written (a local one relative to the
   * project root), the ref and path asked for (null when unset), the commit the ref resolved to
   * and the hash of the tree that was copied in, which is in the digest.
   */
  workspace?: {
    source: string
    ref: string | null
    path: string | null
    commit: string
    tree: string
    /** `init: true`: the workspace had a `.git` with one commit of the tree. */
    init?: boolean
  }
}

/**
 * An attempt's network traffic. `allowed` is every host a restricted policy let through, its own
 * and the automatic ones; null under `allow-all`. `recorded` is false when the sandbox can't see
 * the traffic, and then `contacted` and `blocked` are empty. Bytes are counted between the
 * sandbox and the egress gateway, TLS included. `expectedBlocked` are refused hosts the harness
 * always tries (its CLI's telemetry, say), kept out of `blocked` so a real block stands out.
 */
export type EgressRecord = {
  policy: EgressPolicy
  allowed: string[] | null
  recorded: boolean
  contacted: Array<{
    host: string
    port: number
    connections: number
    sent: number
    received: number
  }>
  blocked: Array<{ host: string; port: number; connections: number; reason: string }>
  expectedBlocked: Array<{ host: string; port: number; connections: number; reason: string }>
}

/** The image an attempt's container started from, and how reeval made it. */
export type AttemptImage = {
  ref: string
  /** Content-addressed image id (`sha256:…`). */
  id: string
  agentCli: string | null
  /** The harness image `install` was baked onto: `ref` itself without `install`. */
  base: string
  /** The `docker({ install })` commands, in order. */
  install: string[]
  /** `docker({ dockerfile })`: the path from the project root and the build context's hash. */
  dockerfile: { path: string; sha256: string } | null
  /**
   * `docker({ from })`: the base as written and the digest the image was built on (a local-only
   * base's image id); `reeval image build` rebuilds it when the tag has moved since.
   */
  from?: { ref: string; digest: string | null }
}

/** What one judge call saw, and for a call that failed, why and what was retried first. */
export type JudgeInput = {
  question: string
  model: string
  state: { [key: string]: JSONValue }
  error?: string
  retries?: JudgeRetry[]
}

/** A harness session start that timed out and was started again. */
export type StartRetry = {
  /** `<harness kind>: session did not become ready within <startTimeout>`. */
  error: string
  /** How long it waited before giving up on that start. */
  waitedMs: number
}

/** Full per-attempt payload, written to disk by the worker. */
export type EvalRecord = {
  /** When the worker began the attempt (its scheduler lease), for start order across the run. */
  startedAt?: string
  outcome: Exclude<Outcome, 'skipped'>
  error: AttemptError | null
  turns: TurnRecord[]
  /** Workspace changes over the whole eval. */
  diff: Diff | null
  checks: Array<{ command: string; durationMs: number } & ExecResult>
  /** With `retries` when transient provider errors were retried on the way to the verdict. */
  judgements: Array<Verdict & { retries?: JudgeRetry[] }>
  /** Session starts that didn't become ready in time and were started again. */
  startRetries?: StartRetry[]
  timings: PhaseTimings
  /** Skills, rules and MCP config visible to the agent, by content hash. */
  context?: Array<{ path: string; sha256: string }>
  /** What each judge call saw, in call order, including calls that errored. */
  judgeInputs?: JudgeInput[]
  environment?: EnvironmentRecord
  image?: AttemptImage | null
  /** Names of the variables and secrets set in the sandbox, and of the brokered secrets among them. */
  env?: { vars: string[]; secrets: string[]; brokered: string[] }
  /** The environment's setup steps as they ran, output redacted later. */
  setup?: Array<{ run: string; exitCode: number | null; durationMs: number; output: string }>
  egress?: EgressRecord
  /** See `AttemptRecord.servedModels`. */
  servedModels?: string[] | null
}

/** Which environment ran as the control, so the studio can show it. */
export type EvalCompareMeta = {
  baseline: string
}

/** How an eval was sized for the plan: what it asked for, and what a profile changed. */
export type EvalPlan = {
  harnesses: number
  /** Variants run, of those the eval compares; null without `compare`. */
  variants: { run: number; of: number } | null
  /** Set when the eval compares variant cells. */
  compare?: EvalCompareMeta
  /** The compare's questions, answered after the run; unset without any, or when a profile dropped them. */
  questions?: PlannedQuestion[]
  runs: number
  /** The eval's gate policy, or undefined when it was left at the default (`'all'`). */
  gate?: GatePolicy
  attempts: number
  notes: string[]
  /** Why the eval doesn't run at all, e.g. a profile's harness limit left none. */
  skip?: string
  /** Warnings about the eval's setup, e.g. a moving git ref. */
  warnings: string[]
  /** Its sandbox runs as root or with capabilities added back; empty for a skipped eval. */
  sandboxWarnings: SandboxWarning[]
  /** Secrets any of its attempts brokers, as `NAME → host, host`. */
  brokered: string[]
  /** Each distinct restricted egress policy its attempts run under, as the plan prints it. */
  egress: string[]
  /** Each distinct git workspace its attempts start from, as `repo#ref:path`. */
  workspaces: string[]
}

/**
 * A sandbox with more privilege than the default `reeval` user: `docker({ root: true })`, or
 * `docker({ capabilities })`. One per level that set such a sandbox, however many evals inherit it.
 */
export type SandboxWarning = {
  kind: 'root' | 'capabilities'
  /** Which level set the sandbox. */
  level: 'config' | 'profile' | 'group' | 'eval'
  /** That level as reeval names it: `reeval.config.ts`, `profiles.pr.defaults`, `group("net")` or `evaluate("installs deps")`. */
  where: string
  /** The eval file that sets it, for a group or eval; null for the config or a profile. */
  file: string | null
  /** The capabilities added back, for `capabilities`. */
  capabilities?: string[]
  /** The line reeval prints, after `WARNING: ` (root) or `warning: ` (capabilities). */
  message: string
}

/** An attempt's egress policy, and the hosts a restricted one allows on top of its own. */
export type PlannedEgress = { policy: EgressPolicy; auto: string[] }

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
  /** The levels that set its sandbox and harness: `reeval.config.ts`, `profiles.pr.defaults`, `group("net")` or `evaluate("x")`. */
  setBy: { sandbox: string; harness: string }
  /** How its cell's attempts decide the cell's outcome; `'none'` when they don't fail the run. */
  gate: CellGate
  /** Set on variant attempts whose compare has a `minLift`. */
  minLift?: number
  /** The secrets this attempt brokers, as `NAME → host, host`. */
  brokered: string[]
  /**
   * The host variables its secrets read, by name: the CLI's own process masks their values on
   * screen, since the attempt's worker is the only other process that knows them.
   */
  secretVars: string[]
  egress: PlannedEgress
  /** The git repository its workspace starts as, which the CLI fetches before any attempt. */
  workspace?: GitWorkspace
  plan: EvalPlan
}

/** Small summary carried through the engine's task metadata. */
export type EvalMeta = {
  outcome: EvalRecord['outcome']
  errorKind: ErrorKind | null
  judgements: Array<Pick<Verdict, 'verdict' | 'score' | 'threshold'> & { question: string }>
  /** Each turn that ended in an error, as `turn 2 error: <message>`, so a failure shows why. */
  turnErrors?: string[]
  /** Its sandbox couldn't be prepared: reported once per sandbox, and it has no artifacts. */
  prepare?: { ref: string | null; stage: string }
}

export type RunContext = {
  runId: string
  stagingDir: string
  config: ResolvedConfig
  /** `reeval run --runs n`: overrides every level. */
  runs?: number
  /** `reeval run --tag` and the profile's tags: each is a tag, or `!tag` to exclude; all must hold. */
  tags: string[]
  /** How many attempts run at once, across the run. */
  concurrency: number
  profile: ResolvedProfile | null
  /** `-v` (1) or `-vv`/`--trace` (2) streams the attempts' debug lines; 0 only writes debug.log. */
  verbosity?: 0 | 1 | 2
  /** The config file, relative to the current directory, for the debug trace; unset without one. */
  configFile?: string
}
