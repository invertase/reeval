import { existsSync } from 'node:fs'
import { availableParallelism, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createJiti } from 'jiti'
import { parseDuration } from './duration.ts'
import { inCI } from './env.ts'
import { helpersFor, isSecret } from './environment.ts'
import { UsageError } from './errors.ts'
import { AGENTS, DEFAULT_HARNESS, HARNESS_EXAMPLE, isAgentKind } from './harness/agents.ts'
import { fromCwd } from './ids.ts'
import { checkModelString, DEFAULT_THRESHOLD, judgeCredentials } from './judge/index.ts'
import { checkHarnesses, checkOptions } from './options.ts'
import { docker } from './sandbox.ts'
import type {
  Budget,
  ConfigHelpers,
  EnvVars,
  EsConfig,
  HarnessDescriptor,
  Profile,
  ResolvedConfig,
  ResolvedProfile,
} from './types.ts'

export { UsageError }

const CONFIG_KEYS = [
  'include',
  'harness',
  'sandbox',
  'environment',
  'runs',
  'gate',
  'env',
  'egress',
  'judge',
  'timeout',
  'concurrency',
  'record',
  'history',
  'budget',
  'profiles',
  'defaultProfile',
  'secrets',
  'debug',
  'analysis',
]
const PROFILE_KEYS = ['defaults', 'limit', 'judge', 'budget', 'record', 'tags']
const DEFAULTS_KEYS = [
  'harness',
  'sandbox',
  'environment',
  'runs',
  'gate',
  'env',
  'egress',
  'judge',
  'timeout',
]
const LIMIT_KEYS = ['runs', 'compare', 'harness']

export type ConfigInput = EsConfig | ((helpers: ConfigHelpers) => EsConfig)

/**
 * The config: a plain object, or a callback that destructures the helpers it needs, e.g.
 * `defineConfig(({ secret }) => ({ env: { KEY: secret.fromEnv('KEY') } }))`.
 */
export const defineConfig = <T extends ConfigInput>(config: T): T => config

export { parseDuration }

/** The file names `es` looks for in each directory, first match first, as Vitest orders its own. */
export const CONFIG_FILES = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map(
  (ext) => `es.config.${ext}`,
)

const DEFAULT_CONFIG_FILE = 'es.config.ts'

/**
 * The nearest config file in `from` or a directory above it, up to the filesystem root, the way
 * Vitest and ESLint find theirs. A git or workspace root doesn't stop the search: a nested
 * project's own config is nearer, so it wins.
 */
export function findConfig(from = process.cwd()): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    for (const name of CONFIG_FILES) {
      const path = join(dir, name)
      if (existsSync(path)) return path
    }
    if (dirname(dir) === dir) return undefined
  }
}

/** The config a command reads: `--config` (from the current directory), else the nearest one. */
export const configPathFor = (flag: string | undefined): string | undefined =>
  flag === undefined ? findConfig() : resolve(flag)

/** The config file as the user would type it from the current directory. */
export const configLabel = (path: string): string => fromCwd(path) || path

/**
 * Loads the config at `path` (see `configPathFor`); its directory is the project root. Without a
 * config file, every key takes its default and the current directory is the root.
 */
export async function loadConfig(
  path: string | undefined,
  command = 'run',
  profile: string | undefined = undefined,
): Promise<ResolvedConfig> {
  if (path === undefined) return resolveConfig({}, process.cwd(), DEFAULT_CONFIG_FILE)
  const root = dirname(path)
  const configPath = configLabel(path)
  let user: EsConfig = {}
  if (existsSync(path)) {
    const jiti = createJiti(import.meta.url, { moduleCache: false })
    const module = (await jiti.import(path)) as Record<string, unknown>
    // Without this, a config that forgets `export default` would run the default harness for real.
    if (!module || typeof module !== 'object' || !('default' in module)) {
      const names = module && typeof module === 'object' ? Object.keys(module) : []
      const exportsNote = names.length ? ` (it exports ${names.join(', ')})` : ''
      throw new UsageError(
        `${configPath} has no default export${exportsNote}. Write export default defineConfig({…}).`,
      )
    }
    let exported = module.default as ConfigInput | Promise<EsConfig>
    if (typeof exported === 'function') {
      const hostEnv = process.env
      exported = exported({ ...helpersFor(root), ci: inCI(hostEnv), command, hostEnv, profile })
      if (exported instanceof Promise) {
        throw new UsageError(
          `The defineConfig callback in ${configPath} returned a Promise. It runs once when the config loads and must return the config synchronously.`,
        )
      }
    }
    if (!exported || typeof exported !== 'object' || exported instanceof Promise) {
      throw new UsageError(`${configPath} must default-export defineConfig({...})`)
    }
    user = exported
  } else {
    throw new UsageError(`Config file not found: ${configPath}`)
  }
  return resolveConfig(user, root, configPath)
}

const GLOB = /[*?[\]{}!]/

/** The directory every include pattern starts in: `evals/**\/*.es.ts` → `evals`. */
export function evalRoot(include: string[]): string {
  const dirs = include.map((pattern) => {
    const parts = pattern.split('/')
    const stop = parts.findIndex((part) => GLOB.test(part))
    return (stop < 0 ? parts.slice(0, -1) : parts.slice(0, stop)).filter((p) => p && p !== '.')
  })
  const common: string[] = []
  for (let i = 0; dirs.every((d) => d[i] !== undefined && d[i] === dirs[0]?.[i]); i++) {
    common.push(dirs[0]?.[i] as string)
  }
  return common.join('/')
}

const ARTIFACTS = ['all', 'failures', 'none'] as const
const RECORD = ['manual', 'ci', 'always'] as const

const unknownKey = (value: object, allowed: string[], where: string) => {
  const key = Object.keys(value).find((k) => !allowed.includes(k))
  if (key === undefined) return
  const hints: Record<string, string> = {
    reuse: 'Reusing control results from .history isn’t built yet; every run runs its controls.',
    compare: 'compare only goes on a group or eval; a profile can narrow it with limit.compare.',
  }
  throw new UsageError(
    `Unknown option "${key}" in ${where}.${hints[key] ? ` ${hints[key]}` : ` Use ${allowed.join(', ')}.`}`,
  )
}

export function checkBudget(budget: unknown, where: string): Budget {
  if (budget === undefined) return {}
  if (typeof budget !== 'object' || budget === null) {
    throw new UsageError(`${where} must be an object like { attempts: 20, duration: '1h' }`)
  }
  if ('usd' in budget || 'tokens' in budget) {
    throw new UsageError(
      `${where}.${'usd' in budget ? 'usd' : 'tokens'} isn't supported yet: ES records the tokens harnesses report, but prices none and enforces no token budget. Cap the run with attempts or duration.`,
    )
  }
  unknownKey(budget, ['attempts', 'duration'], where)
  const { attempts, duration } = budget as Budget
  if (attempts !== undefined && !(Number.isInteger(attempts) && attempts >= 1)) {
    throw new UsageError(`${where}.attempts must be a whole number of at least 1 (got ${attempts})`)
  }
  if (duration !== undefined) parseDuration(duration)
  return { ...(attempts ? { attempts } : {}), ...(duration ? { duration } : {}) }
}

const describeValue = (v: unknown) => {
  if (typeof v !== 'object' || v === null) return JSON.stringify(v)
  const { kind } = v as HarnessDescriptor
  if (kind === 'fake') return 'fakeHarness({ … })'
  return isAgentKind(kind) ? `${AGENTS[kind].factory}({ … })` : 'an object'
}

function checkProfile(name: string, profile: unknown): Profile {
  const where = `profiles.${name}`
  if (typeof profile !== 'object' || profile === null) {
    throw new UsageError(`${where} must be an object with defaults, limit, budget, …`)
  }
  unknownKey(profile, PROFILE_KEYS, where)
  const p = profile as Profile
  if (p.defaults !== undefined) {
    unknownKey(p.defaults, DEFAULTS_KEYS, `${where}.defaults`)
    checkOptions(p.defaults, `${where}.defaults`)
  }
  if (p.limit !== undefined) {
    unknownKey(p.limit, LIMIT_KEYS, `${where}.limit`)
    const { runs, compare, harness } = p.limit
    if (runs !== undefined && !(Number.isInteger(runs) && runs >= 1)) {
      throw new UsageError(`${where}.limit.runs must be a whole number of at least 1`)
    }
    if (
      compare !== undefined &&
      compare !== false &&
      !(Number.isInteger(compare?.maxVariants) && compare.maxVariants >= 0)
    ) {
      throw new UsageError(`${where}.limit.compare must be false or { maxVariants: n }`)
    }
    if (harness !== undefined) {
      const bad = Array.isArray(harness) ? harness.find((h) => typeof h !== 'string') : harness
      if (bad !== undefined) {
        throw new UsageError(
          `${where}.limit.harness can only list harness ids to allow (got ${describeValue(bad)}). To add harnesses, use ${where}.defaults.harness.`,
        )
      }
    }
  }
  if (
    p.tags !== undefined &&
    (!Array.isArray(p.tags) || p.tags.some((t) => typeof t !== 'string'))
  ) {
    throw new UsageError(`${where}.tags must be a list of tag filters`)
  }
  if (p.record !== undefined && !RECORD.includes(p.record)) {
    throw new UsageError(`${where}.record must be one of ${RECORD.join(', ')}`)
  }
  if (p.judge !== undefined) resolveJudge(p.judge, `${where}.judge`)
  checkBudget(p.budget, `${where}.budget`)
  return p
}

/** `--profile`, then `ES_PROFILE`, then `defaultProfile.ci` in CI (or `.local`), then none. */
export function selectProfile(
  config: ResolvedConfig,
  flag: string | undefined,
  env = process.env,
): ResolvedProfile | null {
  const pick = (): [string, string] | null => {
    if (flag) return [flag, '--profile']
    if (env.ES_PROFILE) return [env.ES_PROFILE, 'ES_PROFILE']
    const ci = inCI(env)
    if (ci && config.defaultProfile.ci) return [config.defaultProfile.ci, 'auto: CI is set']
    if (!ci && config.defaultProfile.local) return [config.defaultProfile.local, 'default']
    return null
  }
  const picked = pick()
  if (!picked) return null
  const [name, reason] = picked
  const profile = config.profiles[name]
  if (!profile) {
    const names = Object.keys(config.profiles)
    throw new UsageError(
      `Unknown profile "${name}". ${names.length ? `Profiles in ${config.file}: ${names.join(', ')}.` : `${config.file} defines no profiles.`}`,
    )
  }
  return {
    name,
    reason,
    defaults: profile.defaults ?? {},
    limit: profile.limit ?? {},
    judge: profile.judge ?? {},
    tags: profile.tags ?? [],
    budget: { ...config.budget, ...profile.budget },
    ...(profile.record ? { record: profile.record } : {}),
  }
}

export function resolveConfig(
  user: EsConfig,
  root: string,
  file: string = DEFAULT_CONFIG_FILE,
): ResolvedConfig {
  if ('compare' in user) {
    throw new UsageError(
      `compare can't be set in ${file}: it would multiply every eval. Put it on the group or eval that asks the question.`,
    )
  }
  checkOptions(user, file, CONFIG_KEYS)
  const include = user.include ?? ['evals/**/*.es.ts']
  if (!Array.isArray(include) || include.some((p) => typeof p !== 'string')) {
    throw new UsageError('config.include must be an array of glob strings')
  }
  const record = user.record ?? 'ci'
  if (!RECORD.includes(record)) {
    throw new UsageError(`config.record must be one of ${RECORD.join(', ')}`)
  }
  const artifacts = user.history?.artifacts ?? 'all'
  if (!ARTIFACTS.includes(artifacts)) {
    throw new UsageError(`config.history.artifacts must be one of ${ARTIFACTS.join(', ')}`)
  }
  const historyDir = resolve(root, user.history?.dir ?? join(evalRoot(include), '.history'))
  const harness = user.harness === undefined ? [DEFAULT_HARNESS] : [user.harness].flat()
  if (harness.length === 0) {
    throw new UsageError(
      `harness is an empty list in ${file}. Give at least one, e.g. harness: ${HARNESS_EXAMPLE}`,
    )
  }
  checkHarnesses(harness, file)
  const profiles: Record<string, Profile> = {}
  if (user.profiles !== undefined) {
    if (typeof user.profiles !== 'object' || user.profiles === null) {
      throw new UsageError(`profiles in ${file} must be an object of named profiles`)
    }
    for (const [name, profile] of Object.entries(user.profiles)) {
      profiles[name] = checkProfile(name, profile)
    }
  }
  const defaultProfile = user.defaultProfile ?? {}
  unknownKey(defaultProfile, ['ci', 'local'], 'defaultProfile')
  for (const name of [defaultProfile.ci, defaultProfile.local]) {
    if (name !== undefined && !profiles[name]) {
      throw new UsageError(
        `defaultProfile names "${name}", which isn't in profiles (${Object.keys(profiles).join(', ') || 'none'})`,
      )
    }
  }
  return {
    root,
    file,
    optionKeys: Object.keys(user),
    include,
    harness,
    sandbox: user.sandbox ?? docker(),
    environment: user.environment,
    runs: user.runs ?? 1,
    gate: user.gate,
    env: user.env ?? {},
    ...(user.egress !== undefined ? { egress: user.egress } : {}),
    budget: checkBudget(user.budget, 'budget'),
    profiles,
    defaultProfile,
    judge: resolveJudge(user.judge),
    timeoutMs: parseDuration(user.timeout ?? '15m'),
    concurrency:
      user.concurrency === undefined
        ? undefined
        : checkConcurrency(user.concurrency, 'config.concurrency'),
    record,
    history: { dir: historyDir, artifacts },
    secrets: checkSecrets(user.secrets),
    debug: checkDebug(user.debug),
    analysis: checkAnalysis(user.analysis),
  }
}

export const ANALYSIS_DEFAULTS = { maxInputTokens: 20_000, maxOutputTokens: 8_000 } as const

function checkAnalysis(analysis: EsConfig['analysis']): ResolvedConfig['analysis'] {
  if (analysis === undefined) return { ...ANALYSIS_DEFAULTS }
  if (typeof analysis !== 'object' || analysis === null) {
    throw new UsageError(
      "config.analysis must be an object like { model: 'google/gemini-3.8-flash' }",
    )
  }
  unknownKey(
    analysis,
    ['model', 'instructions', 'maxInputTokens', 'maxOutputTokens'],
    'config.analysis',
  )
  const {
    model,
    instructions,
    maxInputTokens = ANALYSIS_DEFAULTS.maxInputTokens,
    maxOutputTokens = ANALYSIS_DEFAULTS.maxOutputTokens,
  } = analysis
  if (typeof model === 'string') {
    const problem = checkModelString(model)
    if (problem) throw new UsageError(problem.replace('Judge model', 'config.analysis.model'))
  } else if (model !== undefined && (model as { kind?: string })?.kind !== 'fake-analysis') {
    throw new UsageError(
      "config.analysis.model must be a 'provider/model' string, e.g. 'google/gemini-3.8-flash'",
    )
  }
  if (instructions !== undefined && typeof instructions !== 'string') {
    throw new UsageError('config.analysis.instructions must be a string')
  }
  if (!(Number.isInteger(maxInputTokens) && maxInputTokens >= 1000)) {
    throw new UsageError(
      `config.analysis.maxInputTokens must be a whole number of at least 1000 (got ${maxInputTokens})`,
    )
  }
  if (!(Number.isInteger(maxOutputTokens) && maxOutputTokens >= 500)) {
    throw new UsageError(
      `config.analysis.maxOutputTokens must be a whole number of at least 500 (got ${maxOutputTokens})`,
    )
  }
  return { ...analysis, maxInputTokens, maxOutputTokens }
}

/** Runs whose local debug data `.es/debug` keeps, and the trace buffer per attempt. */
export const DEBUG_DEFAULTS = { keep: 20, traceBufferMb: 8 } as const

function checkDebug(debug: EsConfig['debug']): ResolvedConfig['debug'] {
  if (debug === undefined) {
    return { keep: DEBUG_DEFAULTS.keep, traceBufferBytes: DEBUG_DEFAULTS.traceBufferMb * 2 ** 20 }
  }
  if (typeof debug !== 'object' || debug === null) {
    throw new UsageError('config.debug must be an object like { keep: 20, traceBufferMb: 8 }')
  }
  unknownKey(debug, ['keep', 'traceBufferMb'], 'config.debug')
  const { keep = DEBUG_DEFAULTS.keep, traceBufferMb = DEBUG_DEFAULTS.traceBufferMb } = debug
  if (!(Number.isInteger(keep) && keep >= 1)) {
    throw new UsageError(`config.debug.keep must be a whole number of at least 1 (got ${keep})`)
  }
  if (!(typeof traceBufferMb === 'number' && traceBufferMb > 0)) {
    throw new UsageError(
      `config.debug.traceBufferMb must be a number of megabytes above 0 (got ${traceBufferMb})`,
    )
  }
  return { keep, traceBufferBytes: Math.round(traceBufferMb * 2 ** 20) }
}

function checkSecrets(secrets: EsConfig['secrets']): ResolvedConfig['secrets'] {
  if (secrets === undefined) return { unbrokered: 'warn' }
  if (typeof secrets !== 'object' || secrets === null) {
    throw new UsageError("config.secrets must be an object like { unbrokered: 'error' }")
  }
  unknownKey(secrets, ['unbrokered'], 'config.secrets')
  const unbrokered = secrets.unbrokered ?? 'warn'
  if (unbrokered !== 'warn' && unbrokered !== 'error') {
    throw new UsageError(
      `config.secrets.unbrokered is 'warn' or 'error' (got ${JSON.stringify(unbrokered)})`,
    )
  }
  return { unbrokered }
}

export type Capacity = { cpus: number; memoryBytes: number }

export const hostCapacity = (): Capacity => ({
  cpus: availableParallelism(),
  memoryBytes: totalmem(),
})

/**
 * Attempts mostly wait on a model, so the default is 8, but no more than one per CPU or per GB
 * of memory where the sandboxes run (the Docker VM, under Docker Desktop): an idle agent
 * container takes about 300 MB, and the rest is headroom for what the agent runs.
 */
export function defaultConcurrency({ cpus, memoryBytes }: Capacity): number {
  return Math.max(1, Math.min(8, cpus, Math.floor(memoryBytes / 1e9)))
}

function checkConcurrency(value: unknown, where: string): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new UsageError(`${where} must be a whole number of at least 1 (got ${String(value)})`)
  }
  return n
}

/** `--concurrency`, then `ES_CONCURRENCY`, then `concurrency` in the config, then the default. */
export async function resolveConcurrency(
  config: ResolvedConfig,
  flag: string | undefined,
  capacity: () => Promise<Capacity>,
  env = process.env,
): Promise<number> {
  if (flag !== undefined) return checkConcurrency(flag, '--concurrency')
  if (env.ES_CONCURRENCY) return checkConcurrency(env.ES_CONCURRENCY, 'ES_CONCURRENCY')
  return config.concurrency ?? defaultConcurrency(await capacity())
}

function resolveJudge(
  judge: EsConfig['judge'] = {},
  where = 'config.judge',
): ResolvedConfig['judge'] {
  const { model } = judge
  if (typeof model === 'string') {
    const problem = checkModelString(model)
    if (problem) throw new UsageError(`${where}: ${problem}`)
  } else if (model !== undefined && (typeof model !== 'object' || model?.kind !== 'fake-judge')) {
    throw new UsageError(
      `${where}.model must be a "provider/model" string or fakeJudge(). ` +
        'Pass model objects per group, eval or call instead.',
    )
  }
  const threshold = judge.threshold ?? DEFAULT_THRESHOLD
  if (!(threshold >= 0 && threshold <= 1)) {
    throw new UsageError(`${where}.threshold must be between 0 and 1`)
  }
  return { ...judge, threshold }
}

/** Host variables that required `env` secrets read, as `[sandbox name, host name]`. */
export function secretSources(env: EnvVars): Array<[string, string]> {
  return Object.entries(env).flatMap(([name, value]) =>
    isSecret(value) && !value.optional ? [[name, value.from ?? name] as [string, string]] : [],
  )
}

/**
 * Names the environment variables the run's providers need but don't have: the harnesses it
 * plans (default: the config's), the config's judge, and required config and profile secrets.
 */
export function missingCredentials(
  config: ResolvedConfig,
  env = process.env,
  options: { harnessKinds?: string[]; profile?: ResolvedProfile | null } = {},
): string[] {
  const missing: string[] = []
  const kinds = options.harnessKinds ?? config.harness.map((h) => h.kind)
  for (const kind of new Set(kinds)) {
    if (isAgentKind(kind) && !env[AGENTS[kind].credential]) missing.push(AGENTS[kind].credential)
  }
  if (config.judge.model !== undefined) {
    const judgeKeys = judgeCredentials(config.judge.model)
    if (judgeKeys.length && !judgeKeys.some((k) => env[k])) missing.push(judgeKeys.join(' or '))
  }
  const vars = { ...config.env, ...options.profile?.defaults.env }
  for (const [name, from] of secretSources(vars)) {
    if (!env[from]) missing.push(from === name ? name : `${from} (for ${name})`)
  }
  return missing
}

/** Where a value has its first whitespace or control character, from 1; 0 when it has none. */
export const badCharacterAt = (value: string) =>
  [...value].findIndex((c) => /[\s\p{Cc}]/u.test(c)) + 1

/**
 * Keys the run sends in request headers (the agents' credentials and the judge's) whose value has
 * whitespace or a control character in it, with where the first one is: a key pasted from a
 * wrapped terminal line picks up a line break, and the agent then hangs on a request it can't send
 * rather than failing to authenticate.
 */
export function malformedCredentials(
  config: ResolvedConfig,
  env = process.env,
  options: { harnessKinds?: string[] } = {},
): string[] {
  const kinds = options.harnessKinds ?? config.harness.map((h) => h.kind)
  const names = [...new Set(kinds)].flatMap((kind) =>
    isAgentKind(kind) ? [AGENTS[kind].credential] : [],
  )
  if (config.judge.model !== undefined) names.push(...judgeCredentials(config.judge.model))
  return [...new Set(names)].flatMap((name) => {
    const at = badCharacterAt(env[name] ?? '')
    return at ? [`${name} (character ${at})`] : []
  })
}
