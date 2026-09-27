// ES's CLI as data: every command, subcommand, flag and help line. `es` builds its parser
// (`cli-parse.ts`) and its `--help` from it, and `es analyze` checks each suggested verify
// command against it, so a model can't invent a flag.

export type FlagSpec = { type: 'string' | 'boolean'; short?: string; multiple?: boolean }

export const FLAGS = {
  config: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  verbose: { type: 'boolean', short: 'v', multiple: true },
  trace: { type: 'boolean' },
  keep: { type: 'string' },
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
  profile: { type: 'string' },
  'dry-run': { type: 'boolean' },
  force: { type: 'boolean' },
  concurrency: { type: 'string' },
  ui: { type: 'string' },
  'log-order': { type: 'string' },
  'log-prefix': { type: 'string' },
  'output-logs': { type: 'string' },
  tag: { type: 'string', multiple: true },
  port: { type: 'string' },
  host: { type: 'string' },
  open: { type: 'boolean' },
  out: { type: 'string' },
  scratch: { type: 'boolean' },
  'no-scratch': { type: 'boolean' },
  'no-token': { type: 'boolean' },
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
  online: { type: 'boolean' },
} as const satisfies Record<string, FlagSpec>

export type FlagName = keyof typeof FLAGS

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
  /** Its lines in `es --help`, the first naming the command; empty when it has none. */
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
  'tag',
  'record',
  'ui',
  'log-order',
  'log-prefix',
  'output-logs',
  'verbose',
  'trace',
]

export const COMMANDS: Record<string, CommandSpec> = {
  init: {
    flags: ['harness', 'yes', 'force', 'dry-run'],
    positionals: 1,
    help: `
  es init [dir]             Scaffold a project in dir (default: here): es.config.ts, a passing
                            eval, .gitignore entries and a package.json script; asks which agent
    --harness <name>        cursor, claude-code, antigravity, opencode, goose, pi or none (fake
                            agent only); the config's harness, with a fake profile for no keys
    -y, --yes               Don't ask: take the defaults (--harness cursor)
    --force                 Overwrite es.config.ts and the eval when they differ
    --dry-run               Print what it would create or change, and write nothing`,
  },
  doctor: {
    flags: ['online', 'json'],
    positionals: 0,
    help: `
  es doctor                 Check Node and npm, the config, Docker and its memory, the sandbox
                            images, each harness's and the judge's key, egress and .gitignore;
                            exit 1 on a problem, each with its fix. Never prints a key
    --online                Also try each key with one tiny authenticated request
    --json                  The checks as JSON`,
  },
  run: {
    flags: RUN_FLAGS,
    positionals: Number.POSITIVE_INFINITY,
    help: `
  es run [filter...]        Run evals matching config.include; filters are path, name or cell substrings
    --profile <name>        Size the run with a profile from es.config.ts (also ES_PROFILE;
                            default: defaultProfile.ci in CI, else defaultProfile.local)
    --dry-run               Print the plan (evals, cells, attempts, estimate) and exit 0;
                            with --json, as one JSON document (every cell, and what's excluded)
    --force                 Run even when the plan is over budget.attempts
    --runs <n>              Attempts per cell, overriding the config, groups and evals
    --concurrency <n>       Attempts running at once across evals and cells (default 8, at
                            most one per CPU and GB of Docker memory; also ES_CONCURRENCY)
    --tag <tag>             Only evals with this tag; !tag excludes it; repeat to combine (AND)
    --record                Also record the run into the history folder (see config.record)
    --ui <mode>             live, plain or agent (default: agent under a coding agent, plain
                            in CI or when piped, else live; live prints plain for now)
    --log-order <order>     stream (every line as it happens) or grouped (each attempt as one
                            block when it ends); default grouped in CI, else stream
    --log-prefix <prefix>   task or none: the [eval#n harness] prefix on detail lines
                            (default task, none inside GitHub Actions groups)
    --output-logs <level>   full, errors-only or none: whose detail lines print (default full)
    -v, --verbose           Print each attempt's phase trace as it happens: plan, image,
                            container, environment, brokering, turns and tool calls, checks,
                            judge calls, gateway requests and teardown
    -vv, --trace            Also raw payloads, docker commands, headers and DNS decisions, and
                            keep every attempt's trace.ndjson (else only failing attempts')
                            Either way each attempt's debug.log is in .es/debug/<run>/ (local only)`,
  },
  clean: {
    flags: ['keep'],
    positionals: 0,
    help: `
  es clean                  Remove local debug data (.es/debug); --keep <n> keeps the newest n runs`,
  },
  record: {
    flags: ['artifacts', 'allow-incomplete', 'skip-secret-scan'],
    positionals: Number.POSITIVE_INFINITY,
    help: `
  es record [run...]        Copy runs (default: latest) from .es/runs into the history folder
                            --artifacts all|failures|none --allow-incomplete --skip-secret-scan`,
  },
  history: {
    flags: ['limit', 'all', 'json'],
    positionals: Number.POSITIVE_INFINITY,
    help: `
  es history [filter]       Pass/fail per recorded eval over recent runs
                            --limit <n> --all (include unrecorded runs) --json`,
  },
  show: {
    flags: ['json', 'md'],
    positionals: 1,
    help: `
  es show [run]             One run: table, --md (summary.md) or --json (the record)`,
  },
  compare: {
    flags: ['md', 'json', 'fail-on-regression'],
    positionals: 2,
    help: `
  es compare [base] [head]  Diff two runs; base defaults to head's nearest recorded ancestor
                            --md --json --fail-on-regression`,
  },
  checkout: {
    flags: [],
    positionals: 2,
    help: `
  es checkout [run] [dir]   A git worktree at the run's commit, with its worktree.patch applied
                            (default dir: .es/checkouts/<run>)`,
  },
  query: {
    flags: ['json', 'schema', 'rebuild'],
    positionals: Number.POSITIVE_INFINITY,
    help: `
  es query [sql | view]     Read-only SQL over every recorded and scratch run (.es/history.db,
                            rebuilt from the records); views: lift, effort, factor_effects,
                            skill_reads, flaky_cells, drift, failing_attempts, eval_trend,
                            verdict_flips. No argument lists them
    --json                  Rows as JSON; --schema every table and column; --rebuild from scratch`,
  },
  analyze: {
    flags: ['vs', 'eval', 'json', 'md', 'save', 'context', 'dry-run', 'no-cache'],
    positionals: 1,
    help: `
  es analyze [run]          Explain a run with one LLM call over a digest of its facts (vs its
                            nearest recorded ancestor), citations and commands checked; cached
                            in .es/analysis (model: config.analysis.model)
    --vs <run>              The run to compare with; --eval <filter> only matching evals
    --save                  Also write it into the run's history folder: <run>/analysis/
    --context               Print the digest and rules for your own coding agent (no key, no call)
    --dry-run               Print the digest's size and the cache key, without calling the model
    --json --md --no-cache  The analysis as JSON or Markdown; --no-cache calls the model again`,
  },
  studio: {
    flags: ['port', 'host', 'open', 'no-scratch', 'no-token'],
    positionals: 0,
    help: `
  es studio                 Browse runs, evals and transcripts in the web studio (127.0.0.1)
    --port <n>              First port to try (default 4984); --host <addr> (default 127.0.0.1)
    --open                  Open the browser; --no-scratch hides unrecorded runs from .es/runs
    --no-token              Skip the session token (for scripts; anyone local can then read it)`,
    sub: {
      build: {
        flags: ['out', 'scratch', 'no-artifacts'],
        positionals: 0,
        help: `
  es studio build           Write the studio as a static site for Pages, Netlify or any host
    --out <dir>             Output folder (default studio-dist beside the config); --scratch
                            adds unrecorded runs
    --no-artifacts          Records and index only: no transcripts, diffs, logs or judge inputs`,
      },
    },
  },
  image: {
    flags: [],
    positionals: 0,
    help: '',
    sub: {
      build: {
        flags: ['dry-run'],
        positionals: Number.POSITIVE_INFINITY,
        help: `
  es image build [filter...]
                            Build every image the evals' Docker sandboxes need, per harness: ES's
                            image (bakes in its CLI), from and dockerfile images, install layers
    --dry-run               List the images and how each is made, without building`,
      },
    },
  },
}

/** Flags every command takes; without `--config`, `es` finds the nearest config. */
export const GLOBAL: FlagName[] = ['config', 'help', 'version']

/** `es --help`: every command's help lines, in the order of `COMMANDS`. */
export function helpText(version: string): string {
  const commands = Object.values(COMMANDS).flatMap((spec) => [
    spec.help,
    ...Object.values(spec.sub ?? {}).map((sub) => sub.help),
  ])
  return `es ${version} — eval runner for coding agents

Usage:${commands.join('')}
  es --version
  es --help

Runs are latest, latest~N, a run id (or unique prefix), or a git SHA prefix.
Options: --config <path> (default: the nearest es.config.ts, or .mts, .cts, .js, .mjs or .cjs,
in the current directory or above)
Exit codes: 0 passed, 1 failed, 2 usage/config error, 3 infra error, 130 interrupted (Ctrl-C),
143 terminated (SIGTERM)
`
}

/** Splits a command line on whitespace, honouring single and double quotes. */
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

/** An eval as `es run` selects it: by file path, by name (with its groups) or cell, and by tag. */
export type SelectableEval = { file: string; name: string; tags: string[]; cells: string[] }

/**
 * Why `line` isn't a valid ES command line, or null when it is. It may chain `es` commands with
 * `&&` or `;` and start with `npx` or `pnpm`; `es query <name>` must name a view or table in
 * `tables`, when given; `es run` and `es image build` must select at least one of `evals`, when
 * given, with their filters and `--tag`s.
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
 * Why `filters` and `tags` select nothing among `evals`, or null. As `es run` does: a filter that
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
    e.name.includes(f) || e.cells.some((c) => c.includes(f))
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
    return `"${segment}" pipes or substitutes; verify commands are plain es commands`
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
  if (words[0] !== 'es') return `"${segment}" isn't an es command`
  const [, command, ...rest] = words
  if (!command || command.startsWith('-')) {
    return command && ['--help', '-h', '--version'].includes(command) ? null : 'no es command given'
  }
  const spec = COMMANDS[command]
  if (!spec)
    return `es ${command} isn't an ES command (commands: ${Object.keys(COMMANDS).join(', ')})`
  let args = rest
  let name = `es ${command}`
  let target: Omit<CommandSpec, 'sub'> = spec
  if (spec.sub) {
    const sub = args[0] && spec.sub[args[0]]
    if (sub) {
      name = `${name} ${args[0]}`
      target = sub
      args = args.slice(1)
    } else if (command === 'image') return 'es image needs a subcommand: es image build'
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
      if (!flag || !(flag in FLAGS)) return `${arg} isn't an ES flag`
      if (!allowed.has(flag)) return `--${flag} isn't an option of ${name}`
      const type = FLAGS[flag as FlagName].type
      if (type === 'string' && eq === -1) {
        const value = args[i + 1]
        if (value === undefined || value.startsWith('--')) return `--${flag} needs a value`
        i++
        if (flag === 'tag') tags.push(value)
      } else if (flag === 'tag' && eq !== -1) tags.push(arg.slice(eq + 1))
      if (type === 'boolean' && eq !== -1) return `--${flag} takes no value`
      continue
    }
    positionals.push(arg)
  }
  if (positionals.length > target.positionals) {
    return `${name} takes at most ${target.positionals} argument${target.positionals === 1 ? '' : 's'} (got ${positionals.join(' ')})`
  }
  if (evals && (name === 'es run' || name === 'es image build')) {
    const problem = selectionProblem(name, evals, positionals, tags)
    if (problem) return problem
  }
  if (command === 'query' && tables && positionals.length === 1) {
    const text = positionals[0] as string
    if (/^[A-Za-z_]\w*$/.test(text) && !tables.includes(text)) {
      return `es query ${text}: no view or table named ${text} (views: ${tables.join(', ')})`
    }
  }
  return null
}

/** One line per command, for the analysis prompt and `--context`. */
export function commandSummary(): string[] {
  const line = (name: string, spec: Omit<CommandSpec, 'sub'>) =>
    `es ${name}${spec.positionals ? ' [args]' : ''}${spec.flags.length ? ` ${spec.flags.map((f) => `--${f}${FLAGS[f].type === 'string' ? ' <v>' : ''}`).join(' ')}` : ''}`
  return Object.entries(COMMANDS).flatMap(([name, spec]) => [
    ...(name === 'image' ? [] : [line(name, spec)]),
    ...Object.entries(spec.sub ?? {}).map(([sub, s]) => line(`${name} ${sub}`, s)),
  ])
}
