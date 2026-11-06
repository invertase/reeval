// reeval's CLI as data: every command, subcommand, flag and help line. `reeval` builds its parser
// (`cli-parse.ts`) and its `--help` from it, and `reeval analyze` checks each suggested verify
// command against it, so a model can't invent a flag.

export type FlagSpec = {
  type: 'string' | 'boolean'
  short?: string
  multiple?: boolean
  /** A string flag that may be given with no value (`--resume`). */
  optional?: boolean
}

export const FLAGS = {
  config: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  verbose: { type: 'boolean', short: 'v', multiple: true },
  trace: { type: 'boolean' },
  keep: { type: 'string' },
  images: { type: 'boolean' },
  staging: { type: 'boolean' },
  json: { type: 'boolean' },
  md: { type: 'boolean' },
  all: { type: 'boolean' },
  record: { type: 'boolean' },
  artifacts: { type: 'string' },
  'allow-incomplete': { type: 'boolean' },
  'skip-secret-scan': { type: 'boolean' },
  limit: { type: 'string' },
  'fail-on-regression': { type: 'boolean' },
  runs: { type: 'string' },
  run: { type: 'string' },
  profile: { type: 'string' },
  'dry-run': { type: 'boolean' },
  force: { type: 'boolean' },
  registry: { type: 'string' },
  push: { type: 'boolean' },
  concurrency: { type: 'string' },
  ui: { type: 'string' },
  'log-order': { type: 'string' },
  'log-prefix': { type: 'string' },
  'output-logs': { type: 'string' },
  tag: { type: 'string', multiple: true },
  trait: { type: 'string', multiple: true },
  http: { type: 'boolean' },
  port: { type: 'string' },
  host: { type: 'string' },
  open: { type: 'boolean' },
  out: { type: 'string' },
  scratch: { type: 'boolean' },
  'no-scratch': { type: 'boolean' },
  'no-token': { type: 'boolean' },
  token: { type: 'string' },
  'no-artifacts': { type: 'boolean' },
  schema: { type: 'boolean' },
  rebuild: { type: 'boolean' },
  vs: { type: 'string' },
  eval: { type: 'string' },
  save: { type: 'boolean' },
  context: { type: 'boolean' },
  'no-cache': { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  harness: { type: 'string' },
  bare: { type: 'boolean' },
  online: { type: 'boolean' },
  offline: { type: 'boolean' },
  debug: { type: 'boolean' },
  'all-branches': { type: 'boolean' },
  'push-only': { type: 'boolean' },
  issue: { type: 'boolean' },
  last: { type: 'boolean' },
  resume: { type: 'string', optional: true },
  'retry-errors': { type: 'string', optional: true },
  events: { type: 'boolean' },
  'events-file': { type: 'string' },
  'events-url': { type: 'string' },
} as const satisfies Record<string, FlagSpec>

export type FlagName = keyof typeof FLAGS

export const isFlagName = (name: string): name is FlagName => name in FLAGS

type FlagValue<S extends FlagSpec> = S extends { type: 'string' }
  ? S extends { multiple: true }
    ? string[]
    : string
  : S extends { multiple: true }
    ? boolean[]
    : boolean

/** The parsed flags, keyed by their spec name (`dry-run`, `no-cache`); unset flags are absent. */
export type Flags = { -readonly [K in FlagName]?: FlagValue<(typeof FLAGS)[K]> }

export type CommandSpec = {
  flags: FlagName[]
  /** How many positional arguments it takes; `Infinity` for filters or SQL. */
  positionals: number
  /** Its lines in `reeval --help`, the first naming the command; empty when it has none. */
  help: string
  sub?: Record<string, Omit<CommandSpec, 'sub'>>
}

const RUN_FLAGS: FlagName[] = [
  'profile',
  'dry-run',
  'json',
  'force',
  'runs',
  'concurrency',
  'registry',
  'tag',
  'trait',
  'record',
  'ui',
  'log-order',
  'log-prefix',
  'output-logs',
  'verbose',
  'resume',
  'retry-errors',
  'events',
  'events-file',
  'events-url',
]

export const COMMANDS: Record<string, CommandSpec> = {
  init: {
    flags: ['harness', 'yes', 'bare', 'force', 'dry-run'],
    positionals: 1,
    help: `
  reeval init [dir]             Scaffold a project in dir (default: here): reeval.config.ts, an
                                environment, an eval that runs in it, .gitignore entries and a
                                package.json script; asks which agent, then checks Docker
    --harness <name>            cursor, claude-code, antigravity, opencode, goose, pi, codex, fx or
                                grok-build: the config's harness
    -y, --yes                   Don't ask: take the defaults (--harness cursor)
    --bare                      Only reeval.config.ts, .gitignore and package.json: no environment
                                or eval
    --force                     Replace a reeval.config.ts init didn't write; no other file is ever
                                overwritten
    --dry-run                   Print what it would create or change, and write nothing`,
  },
  doctor: {
    flags: ['online', 'json'],
    positionals: 0,
    help: `
  reeval doctor                 Check Node and npm, the config, Docker and its memory, the sandbox
                                images, the keys of each harness, the judge and analysis.model,
                                egress, .gitignore and keys in .env files git sees; exit 1 on a
                                problem, each with its fix. Never prints a key
    --online                    Also try each key with one tiny authenticated request
    --json                      The checks as JSON`,
  },
  run: {
    flags: RUN_FLAGS,
    positionals: Number.POSITIVE_INFINITY,
    help: `
  reeval run [filter...]        Run evals matching config.include; filters are path, name or cell substrings
                                (parts of one kind OR; a name and a cell key are one kind)
    --profile <name>            Size the run with a profile from reeval.config.ts (also REEVAL_PROFILE;
                                default: defaultProfile.ci in CI, else defaultProfile.local)
    --dry-run                   Print the plan (evals, cells, attempts, time and cost) and exit 0;
                                with --json, as one JSON document (every cell, what's excluded and
                                the host files the run reads, in inputs)
    --json                      Print the run's results (suiteResult from reeval/view) as one JSON
                                document on stdout when it ends; progress goes to stderr
    --force                     Run even when the plan is over budget.attempts
    --runs <n>                  Attempts per cell, overriding the config, groups and evals
    --concurrency <n>           Attempts running at once across evals and cells (default 8, at
                                most one per CPU and GB of Docker memory; also REEVAL_CONCURRENCY)
    --registry <prefix>         Pull each sandbox image that isn't built here from this registry
                                (host[:port]/path, as reeval image build --push left it) before
                                building it; one it doesn't have is built as usual
    --tag <tag>                 Only evals with this tag; !tag excludes it; repeat to combine (AND)
    --trait <key=value>         Only cells whose environment's trait is value, or lists it (with
                                compare, the control's); repeat to combine (AND)
    --record                    Also record the run into the history folder (see config.record)
    --ui <mode>                 plain or agent (default: agent under a coding agent, else plain,
                                an eval list you browse with the arrow keys on a terminal outside CI)
    --log-order <order>         stream (every line as it happens) or grouped (each attempt as one
                                block when it ends); default grouped in CI, else stream
    --log-prefix <prefix>       task or none: the [eval#n harness] prefix on detail lines
                                (default task, none inside GitHub Actions groups)
    --output-logs <level>       full, errors-only or none: whose detail lines print as attempts
                                end (default none, the eval list says how each went; full with -v)
    -v, --verbose               Print each attempt's phase trace as it happens: plan, image,
                                container, environment, brokering, turns and tool calls, checks,
                                judge calls, gateway requests and teardown
    -vv                         Also raw payloads, docker commands, headers and DNS decisions, and
                                keep every attempt's trace.ndjson (else only failing attempts')
                                Either way each attempt's debug.log is in .reeval/debug/<run>/ (local only)
    --resume [ref]              Continue a stopped, interrupted or budget-stopped run: same run id,
                                keep passed and failed attempts, restart in-flight and infra-errored
                                ones. Without a ref, the newest resumable (Stopped staging, or an
                                interrupted/budget scratch), not assembled latest. Ref is a run id or
                                unique prefix
    --retry-errors [ref]        Re-run a finished run's infra-errored attempts with its plan, into
                                the same run; passes and fails stay. Without a ref, the newest
                                finished run. Exit 2 when the plan or eval source changed since
    --events                    Also write the run's output events as NDJSON for reeval attach, to
                                .reeval/events/<run>.ndjson; a resume appends to it
    --events-file <file>        The same, to file; refuses a file that isn't a run's event stream
    --events-url <url>          Also POST them to url, in batches of NDJSON lines`,
  },
  attach: {
    flags: ['ui', 'log-order', 'log-prefix', 'output-logs'],
    positionals: 1,
    help: `
  reeval attach [run|file|url]  Follow a reeval run's --events stream and print it as reeval run
                                does, from its start; exit with the run's exit code (default: the
                                run in progress; a URL is read with GET as NDJSON)
    --ui --log-order --log-prefix --output-logs
                                As for reeval run`,
  },
  clean: {
    flags: ['keep', 'images', 'staging'],
    positionals: 0,
    help: `
  reeval clean                  Remove local debug data (.reeval/debug), snapshots (in .reeval/runs)
                                and finished runs' event streams (.reeval/events); --keep <n> keeps
                                the newest n runs'
    --images                    Also remove the Docker images reeval built that nothing tags any more,
                                and the intermediate -base tags of from builds; with Tart, delete
                                every Tart image reeval baked a harness into that isn't running
    --staging                   Also delete every stopped run's staging (.reeval/staging), so
                                reeval run --resume can no longer finish it`,
  },
  record: {
    flags: ['artifacts', 'allow-incomplete', 'skip-secret-scan', 'profile'],
    positionals: Number.POSITIVE_INFINITY,
    help: `
  reeval record [run...]        Copy runs (default: latest) from .reeval/runs into the history folder
                                --artifacts all|failures|none --allow-incomplete --skip-secret-scan
    --profile <name>            Use the history store the profile sets (also REEVAL_PROFILE)`,
  },
  history: {
    flags: ['limit', 'all', 'json', 'profile', 'offline', 'all-branches'],
    positionals: Number.POSITIVE_INFINITY,
    help: `
  reeval history [filter]       Pass/fail per recorded eval over recent runs
                                --limit <n> --all (include unrecorded runs) --json
    --offline --all-branches    A remote history.store: read its copy without pulling first; list
                                every branch's runs, not only HEAD's
    --profile <name>            Use the history store the profile sets (also REEVAL_PROFILE)`,
  },
  show: {
    flags: ['json', 'md', 'trace', 'out', 'profile', 'offline', 'all-branches'],
    positionals: 1,
    help: `
  reeval show [run]             One run: result blocks, --md (summary.md) or --json (the record)
    --trace                     Write its timeline as Chrome Trace Event JSON for ui.perfetto.dev:
                                attempts in lanes, with setup, turns, tool calls, checks and judge
    --out <file>                With --trace, where to write it (default .reeval/traces/<run>.json)
    --offline --all-branches    A remote history.store: read its copy without pulling first; list
                                every branch's runs, not only HEAD's
    --profile <name>            Use the history store the profile sets (also REEVAL_PROFILE)`,
  },
  compare: {
    flags: ['md', 'json', 'fail-on-regression', 'verbose', 'profile', 'offline', 'all-branches'],
    positionals: 2,
    help: `
  reeval compare [base] [head]  Diff two runs; base defaults to head's nearest recorded ancestor
                                --md --json --fail-on-regression
    -v, --verbose               Also each cell's lift and effort and each variant's comparison with
                                its baseline, base → head, and the stack changes
    --offline --all-branches    A remote history.store: read its copy without pulling first; list
                                every branch's runs, not only HEAD's
    --profile <name>            Use the history store the profile sets (also REEVAL_PROFILE)`,
  },
  checkout: {
    flags: ['profile', 'offline', 'all-branches'],
    positionals: 2,
    help: `
  reeval checkout [run] [dir]   A git worktree at the run's commit, with its worktree.patch applied
                                (default dir: .reeval/checkouts/<run>)
    --offline --all-branches    A remote history.store: read its copy without pulling first; list
                                every branch's runs, not only HEAD's
    --profile <name>            Use the history store the profile sets (also REEVAL_PROFILE)`,
  },
  sync: {
    flags: ['profile', 'debug', 'push-only'],
    positionals: Number.POSITIVE_INFINITY,
    help: `
  reeval sync [--debug run...]  Upload the runs recorded to history.store that didn't upload
                                (kept in .reeval/store/<id>/pending), then download the runs
                                recorded elsewhere; exit 3 if the store fails
    --debug                     Then download each run's debug data (default latest), which a
                                pull leaves in the store, into .reeval/debug/<run>
    --push-only                 Upload, then check the store answers instead of downloading
    --profile <name>            Use the history store the profile sets (also REEVAL_PROFILE)`,
  },
  query: {
    flags: ['json', 'schema', 'rebuild', 'run', 'profile', 'offline'],
    positionals: Number.POSITIVE_INFINITY,
    help: `
  reeval query [sql | view]     Read-only SQL over every recorded and scratch run (.reeval/history.db,
                                rebuilt from the records); views: lift, effort, factor_effects,
                                measure_effects, skill_reads, flaky_cells, drift, failing_attempts,
                                eval_trend, verdict_flips, check_discrimination, check_rates,
                                check_streaks. No argument lists them
    --run <id|last>             Bind the run id (or the last run's) to :run in the SQL; with a view
                                or table name, only that run's rows
    --json                      Rows as JSON; --schema every table and column; --rebuild from scratch
    --offline                   A remote history.store: read its copy without pulling first
    --profile <name>            Use the history store the profile sets (also REEVAL_PROFILE)`,
  },
  analyze: {
    flags: [
      'vs',
      'eval',
      'json',
      'md',
      'save',
      'context',
      'dry-run',
      'no-cache',
      'profile',
      'offline',
      'all-branches',
    ],
    positionals: 1,
    help: `
  reeval analyze [run]          Explain a run with one LLM call over a digest of its facts (vs its
                                nearest recorded ancestor), citations and commands checked; cached
                                in .reeval/analysis (model: config.analysis.model)
    --vs <run>                  The run to compare with; none for this run only;
                                --eval <filter> only matching evals
    --save                      Also write it into the run's history folder: <run>/analysis/
    --context                   Print the digest and rules for your own coding agent (no key, no call)
    --dry-run                   Print the digest's size and the cache key, without calling the model
    --json --md --no-cache      The analysis as JSON or Markdown; --no-cache calls the model again
    --offline --all-branches    A remote history.store: read its copy without pulling first; list
                                every branch's runs, not only HEAD's
    --profile <name>            Use the history store the profile sets (also REEVAL_PROFILE)`,
  },
  mcp: {
    flags: ['http', 'port', 'host', 'token', 'profile', 'offline', 'all-branches'],
    positionals: 0,
    help: `
  reeval mcp                    Serve the run history to other agents over MCP (stdio): read-only
                                tools for why a run failed, reeval query's views and SQL,
                                history, show, compare, transcripts and saved analyses, and runs
                                as resources
    --http                      Stateless Streamable HTTP on 127.0.0.1 instead, at /mcp;
                                --port <n> (default 4986), --host <addr>
    --token <value>             With --http, require it as a bearer token (also REEVAL_MCP_TOKEN)
    --offline --all-branches    A remote history.store: read its copy without pulling first; list
                                every branch's runs, not only HEAD's
    --profile <name>            Use the history store the profile sets (also REEVAL_PROFILE)`,
  },
  studio: {
    flags: ['port', 'host', 'open', 'no-scratch', 'no-token', 'profile'],
    positionals: 0,
    help: `
  reeval studio                 Browse runs, evals and transcripts in the web studio (127.0.0.1)
    --port <n>                  First port to try (default 4984); --host <addr> (default 127.0.0.1)
    --open                      Open the browser; --no-scratch hides unrecorded runs from .reeval/runs
    --no-token                  Skip the session token (for scripts; anyone local can then read it)
    --profile <name>            Use the history store the profile sets (also REEVAL_PROFILE)`,
    sub: {
      build: {
        flags: ['out', 'scratch', 'no-artifacts', 'profile'],
        positionals: 0,
        help: `
  reeval studio build           Write the studio as a static site for Pages, Netlify or any host
    --out <dir>                 Output folder (default studio-dist beside the config); --scratch
                                adds unrecorded runs
    --no-artifacts              Records and index only: no transcripts, diffs, logs or judge inputs
    --profile <name>            Use the history store the profile sets (also REEVAL_PROFILE)`,
      },
    },
  },
  report: {
    flags: ['out', 'json', 'last', 'issue', 'yes'],
    positionals: 1,
    help: `
  reeval report [run]           Collect a bug report: versions, reeval doctor, the config's shape, the
                                last reeval command's error and stack, the run's failures and their
                                .reeval/debug logs, redacted. Prints a summary, writes it to .reeval/reports
                                and uploads nothing
    --out <dir|file>            Write report.md, report.json and report-logs.tar.gz there instead
                                (a .md or .json file writes the others beside it)
    --json                      The bundle as JSON on stdout
    --last                      Report the last reeval command that failed, and its run
    --issue                     Open a pre-filled GitHub issue for reeval in the browser, or with gh
                                installed, file it with gh issue create once you confirm
    -y, --yes                   With --issue, file it with gh without asking`,
  },
  image: {
    flags: [],
    positionals: 0,
    help: '',
    sub: {
      build: {
        flags: ['profile', 'dry-run', 'force', 'registry', 'push'],
        positionals: Number.POSITIVE_INFINITY,
        help: `
  reeval image build [filter...]
                                Build every image the evals' Docker sandboxes need, per harness: reeval's
                                image (bakes in its CLI), from and dockerfile images, install layers.
                                Builds what's missing or stale (a from tag that moved upstream), three
                                at a time, and reports every failure; exit 3 if any image failed.
                                Pulls the tart() images Tart doesn't have, with tart pull, once the
                                disk has room for them, counting what Tart prunes from its cache
                                (exit 3 if not), then bakes each real harness's CLI into a local copy
                                of its image that attempts clone; runs no Docker without a Docker
                                sandbox
    --profile <name>            Plan with a profile from reeval.config.ts, as reeval run does, so its
                                harness, sandbox and tags pick the images (also REEVAL_PROFILE)
    --force                     Rebuild every image, pulling each base again (and each tart() tag),
                                and bake each tart() harness image anew
    --registry <prefix>         Pull each image that isn't built here from this registry
                                (host[:port]/path) before building it. Its tags hash what goes in
                                each image, not this machine's image ids, so another machine's
                                build of the same inputs is the one pulled
    --push                      With --registry, push every image reeval built or pulled for the
                                evals there (docker or podman push; log in first)
    --dry-run                   List the images, how each is made and how each stands, building
                                and pulling nothing (a from tag or tart() image is looked up in its
                                registry, not pulled), and whether the tart() pulls fit the disk`,
      },
    },
  },
}

/** Flags every command takes; without `--config`, `reeval` finds the nearest config. */
export const GLOBAL: FlagName[] = ['config', 'help', 'version']

/**
 * What to use instead of a flag on a command that doesn't take it, by `<command> --<flag>`, for
 * the flags people look for on the wrong command.
 */
export const INSTEAD: Record<string, string> = {
  'reeval run --trace':
    "-vv keeps every attempt's trace.ndjson in .reeval/debug, and reeval show --trace writes a run's timeline for ui.perfetto.dev",
}

const HELP_FOOTER = `Options: --config <path> (default: the nearest reeval.config.ts, or .mts, .cts, .js, .mjs, .cjs,
or reeval.yaml, in the current directory or above)
Exit codes: 0 passed, 1 failed, 2 usage/config error, 3 infra error, 130 interrupted (Ctrl-C),
143 terminated (SIGTERM)
`

const helpLines = (spec: CommandSpec) => [
  spec.help,
  ...Object.values(spec.sub ?? {}).map((sub) => sub.help),
]

/** `reeval --help`: every command's help lines, in the order of `COMMANDS`. */
export function helpText(version: string): string {
  return `reeval ${version} — eval runner for coding agents

Usage:${Object.values(COMMANDS).flatMap(helpLines).join('')}
  reeval --version
  reeval --help

Runs are latest, latest~N, a run id (or unique prefix), or a git SHA prefix.
${HELP_FOOTER}`
}

/**
 * `reeval <command> [sub] --help`: that command's help lines (and its subcommands' when no
 * subcommand is named), or the whole of `reeval --help` for a command it doesn't know.
 */
export function commandHelpText(version: string, path: string[]): string {
  const [name = '', subName = ''] = path
  const spec = COMMANDS[name]
  if (!spec) return helpText(version)
  const sub = spec.sub?.[subName]
  const lines = sub ? [sub.help] : helpLines(spec)
  return `reeval ${version} — eval runner for coding agents

Usage:${lines.join('')}

${HELP_FOOTER}`
}

/** Splits a command line on whitespace, honoring single and double quotes. */
export function shellWords(line: string): string[] | null {
  const words: string[] = []
  let word = ''
  let quote: string | null = null
  let started = false
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null
      else word += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started || word) words.push(word)
      word = ''
      started = false
    } else {
      word += ch
      started = true
    }
  }
  if (quote) return null
  if (started || word) words.push(word)
  return words
}

const RUNNERS = [['npx'], ['pnpm', 'exec'], ['pnpm'], ['npm', 'exec', '--'], ['yarn']]

/** An eval as `reeval run` selects it: by file path, by id, by name (with its groups) or cell, and by tag. */
export type SelectableEval = {
  file: string
  name: string
  /** The record's eval id (`file › group › … › name`), when the digest has it. */
  id?: string
  tags: string[]
  cells: string[]
}

/**
 * Why `line` isn't a valid reeval command line, or null when it is. It may chain `reeval` commands with
 * `&&` or `;` and start with `npx` or `pnpm`; `reeval query <name>` must name a view or table in
 * `tables`, when given; `reeval run` and `reeval image build` must select at least one of `evals`, when
 * given, with their filters (`reeval run` also with `--tag`s).
 */
export function checkCommand(
  line: string,
  tables?: readonly string[],
  evals?: readonly SelectableEval[],
): string | null {
  const segments = line.split(/\s*(?:&&|;)\s*/).filter((s) => s.trim())
  if (segments.length === 0) return 'empty command'
  for (const segment of segments) {
    const problem = checkOne(segment, tables, evals)
    if (problem) return problem
  }
  return null
}

/**
 * Why `filters` and `tags` select nothing among `evals`, or null. As `reeval run` does: a filter that
 * names an eval file picks files, any other picks evals by name or cell, and the two narrow each
 * other; every `--tag` must hold (`!tag` excludes).
 */
export function selectionProblem(
  name: string,
  evals: readonly SelectableEval[],
  filters: string[],
  tags: string[],
): string | null {
  const known = [...new Set(evals.flatMap((e) => e.tags))].sort()
  for (const tag of tags) {
    const bare = tag.replace(/^!/, '')
    if (!known.includes(bare)) {
      return `${name} --tag ${tag}: no eval in the run has the tag ${bare} (tags: ${known.join(', ') || 'none'})`
    }
  }
  const byName = (e: SelectableEval, f: string) =>
    e.name.includes(f) || e.cells.some((c) => c.includes(f)) || e.id?.includes(f)
  const paths = filters.filter((f) => evals.some((e) => e.file.includes(f.replace(/^\.\//, ''))))
  const names = filters.filter((f) => !paths.includes(f))
  const unknown = names.filter((f) => !evals.some((e) => byName(e, f)))
  if (unknown.length) {
    return `${name}: filter ${unknown.map((f) => `"${f}"`).join(', ')} matches no eval file, eval name or cell in the run`
  }
  const selected = evals.filter(
    (e) =>
      tags.every((t) => (t.startsWith('!') ? !e.tags.includes(t.slice(1)) : e.tags.includes(t))) &&
      (!paths.length || paths.some((f) => e.file.includes(f.replace(/^\.\//, '')))) &&
      (!names.length || names.some((f) => byName(e, f))),
  )
  return selected.length
    ? null
    : `${name} ${[...filters, ...tags.map((t) => `--tag ${t}`)].join(' ')} selects no eval in the run`
}

function checkOne(
  segment: string,
  tables?: readonly string[],
  evals?: readonly SelectableEval[],
): string | null {
  if (/[|<>`$]/.test(segment.replace(/"[^"]*"|'[^']*'/g, ''))) {
    return `"${segment}" pipes or substitutes; verify commands are plain reeval commands`
  }
  let words = shellWords(segment)
  if (!words) return `unbalanced quotes in "${segment}"`
  while (words[0] && /^[A-Z_][A-Z0-9_]*=/.test(words[0])) words = words.slice(1)
  for (const runner of RUNNERS) {
    if (runner.every((w, i) => words?.[i] === w)) {
      words = words.slice(runner.length)
      break
    }
  }
  if (words[0] !== 'reeval' && words[0] !== 're') return `"${segment}" isn't a reeval command`
  const [, command, ...rest] = words
  if (!command || command.startsWith('-')) {
    return command && ['--help', '-h', '--version'].includes(command)
      ? null
      : 'no reeval command given'
  }
  const spec = COMMANDS[command]
  if (!spec)
    return `reeval ${command} isn't a reeval command (commands: ${Object.keys(COMMANDS).join(', ')})`
  let args = rest
  let name = `reeval ${command}`
  let target: Omit<CommandSpec, 'sub'> = spec
  if (spec.sub) {
    const sub = args[0] && spec.sub[args[0]]
    if (sub) {
      name = `${name} ${args[0]}`
      target = sub
      args = args.slice(1)
    } else if (command === 'image') return 'reeval image needs a subcommand: reeval image build'
  }
  const allowed = new Set<string>([...target.flags, ...GLOBAL])
  const positionals: string[] = []
  const tags: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--') {
      positionals.push(...args.slice(i + 1))
      break
    }
    if (/^-v+$/.test(arg) && allowed.has('verbose')) continue
    if (arg.startsWith('-') && arg !== '-') {
      const eq = arg.indexOf('=')
      const raw = arg.startsWith('--') ? arg.slice(2, eq === -1 ? undefined : eq) : arg.slice(1)
      const flag = arg.startsWith('--')
        ? raw
        : Object.entries(FLAGS).find(([, s]) => 'short' in s && s.short === raw)?.[0]
      if (!flag || !isFlagName(flag)) return `${arg} isn't a reeval flag`
      if (!allowed.has(flag)) return `--${flag} isn't an option of ${name}`
      const spec = FLAGS[flag]
      const type = spec.type
      if (type === 'string' && eq === -1) {
        const value = args[i + 1]
        if (value === undefined || value.startsWith('--')) {
          if (!('optional' in spec && spec.optional)) return `--${flag} needs a value`
        } else {
          i++
          if (flag === 'tag') tags.push(value)
        }
      } else if (flag === 'tag' && eq !== -1) tags.push(arg.slice(eq + 1))
      if (type === 'boolean' && eq !== -1) return `--${flag} takes no value`
      continue
    }
    positionals.push(arg)
  }
  if (positionals.length > target.positionals) {
    return `${name} takes at most ${target.positionals} argument${target.positionals === 1 ? '' : 's'} (got ${positionals.join(' ')})`
  }
  if (evals && (name === 'reeval run' || name === 'reeval image build')) {
    const problem = selectionProblem(name, evals, positionals, tags)
    if (problem) return problem
  }
  if (command === 'query' && tables && positionals.length === 1) {
    const text = positionals[0] as string
    if (/^[A-Za-z_]\w*$/.test(text) && !tables.includes(text)) {
      return `reeval query ${text}: no view or table named ${text} (views and tables: ${tables.join(', ')})`
    }
  }
  return null
}

/** One line per command, for the analysis prompt and `--context`. */
export function commandSummary(): string[] {
  const line = (name: string, spec: Omit<CommandSpec, 'sub'>) =>
    `reeval ${name}${spec.positionals ? ' [args]' : ''}${spec.flags.length ? ` ${spec.flags.map((f) => `--${f}${FLAGS[f].type === 'string' ? ('optional' in FLAGS[f] && FLAGS[f].optional ? ' [v]' : ' <v>') : ''}`).join(' ')}` : ''}`
  return Object.entries(COMMANDS).flatMap(([name, spec]) => [
    ...(name === 'image' ? [] : [line(name, spec)]),
    ...Object.entries(spec.sub ?? {}).map(([sub, s]) => line(`${name} ${sub}`, s)),
  ])
}
