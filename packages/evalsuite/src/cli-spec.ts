// ES's CLI as data: every command, subcommand and flag. `es` parses its arguments from it, and
// `es analyze` checks each suggested verify command against it, so a model can't invent a flag.

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
} as const satisfies Record<string, FlagSpec>

export type FlagName = keyof typeof FLAGS

type CommandSpec = {
  flags: FlagName[]
  /** How many positional arguments it takes; `Infinity` for filters or SQL. */
  positionals: number
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
  run: { flags: RUN_FLAGS, positionals: Number.POSITIVE_INFINITY },
  clean: { flags: ['keep'], positionals: 0 },
  record: {
    flags: ['artifacts', 'allow-incomplete', 'skip-secret-scan'],
    positionals: Number.POSITIVE_INFINITY,
  },
  history: { flags: ['limit', 'all', 'json'], positionals: Number.POSITIVE_INFINITY },
  show: { flags: ['json', 'md'], positionals: 1 },
  compare: { flags: ['md', 'json', 'fail-on-regression'], positionals: 2 },
  checkout: { flags: [], positionals: 2 },
  query: { flags: ['json', 'schema', 'rebuild'], positionals: Number.POSITIVE_INFINITY },
  analyze: {
    flags: ['vs', 'eval', 'json', 'md', 'save', 'context', 'dry-run', 'no-cache'],
    positionals: 1,
  },
  studio: {
    flags: ['port', 'host', 'open', 'no-scratch', 'no-token'],
    positionals: 0,
    sub: { build: { flags: ['out', 'scratch', 'no-artifacts'], positionals: 0 } },
  },
  image: {
    flags: [],
    positionals: 0,
    sub: { build: { flags: ['dry-run'], positionals: Number.POSITIVE_INFINITY } },
  },
}

const GLOBAL: FlagName[] = ['config', 'help', 'version']

/** `parseArgs` options for every flag; without `--config`, `es` finds the nearest config. */
export const parseOptions = () => FLAGS

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
