import { existsSync, readFileSync } from 'node:fs'
import { availableParallelism, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import { configDataProblem } from './contract/config.ts'
import { judgeProblem } from './contract/judge.ts'
import { closest, oneOf } from './contract/shared.ts'
import { parseDuration } from './duration.ts'
import { inCI } from './env.ts'
import {
  environmentFrom,
  helpersFor,
  isEnvironment,
  isSecret,
  type MissingDockerfile,
  sandboxPaths,
  specPaths,
} from './environment.ts'
import { UsageError } from './errors.ts'
import {
  AGENTS,
  credentialOf,
  DEFAULT_HARNESS,
  HARNESS_EXAMPLE,
  isAgentKind,
} from './harness/agents.ts'
import { fromCwd } from './ids.ts'
import { reevalJiti } from './jiti.ts'
import { checkModelString, DEFAULT_THRESHOLD, judgeCredentials } from './judge/index.ts'
import { isObjectLike } from './object.ts'
import { checkHarnesses, checkOptions, profileJudge } from './options.ts'
import { ownFileURL } from './root.ts'
import { docker } from './sandbox.ts'
import type {
  Budget,
  ConfigHelpers,
  EnvVars,
  HarnessDescriptor,
  Profile,
  ProfileData,
  ReevalConfig,
  ReevalConfigData,
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
  'capture',
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
  'capture',
  'timeout',
]
const LIMIT_KEYS = ['runs', 'compare', 'harness']

export type ConfigInput = ReevalConfig | ((helpers: ConfigHelpers) => ReevalConfig)

/**
 * The config: a plain object, or a callback that destructures the helpers it needs, e.g.
 * `defineConfig(({ secret }) => ({ env: { KEY: secret.fromEnv('KEY') } }))`.
 */
export const defineConfig = <T extends ConfigInput>(config: T): T => config

export { parseDuration }

/** The script configs `reeval` looks for in each directory, first match first, as Vitest orders its own. */
const SCRIPT_FILES = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map((ext) => `reeval.config.${ext}`)

/** The data configs, for projects without TypeScript: one of them, and no script config beside it. */
const YAML_FILES = ['reeval.yaml', 'reeval.yml']

/** Every file name `reeval` looks for in each directory. */
export const CONFIG_FILES = [...SCRIPT_FILES, ...YAML_FILES]

/** True for a `reeval.yaml`-style config, which is data rather than a module. */
export const isYamlConfig = (path: string): boolean => /\.ya?ml$/i.test(path)

const DEFAULT_CONFIG_FILE = 'reeval.config.ts'

/** The names `findConfig` looks for, as doctor and the missing-config error list them. */
export const configFilesPhrase = (): string =>
  `${CONFIG_FILES[0]} (or ${CONFIG_FILES.slice(1).join(', ')})`

/** Usage error when `findConfig()` finds nothing: same names as doctor, plus `reeval init`. */
export const missingConfigMessage = (): string =>
  `No ${configFilesPhrase()} here or above. Run reeval init.`

/** A found config path, or the missing-config usage error. */
export function requireConfig(path: string | undefined): string {
  if (path === undefined) throw new UsageError(missingConfigMessage())
  return path
}

/**
 * The nearest config file in `from` or a directory above it, up to the filesystem root, the way
 * Vitest and ESLint find theirs. A git or workspace root doesn't stop the search: a nested
 * project's own config is nearer, so it wins.
 */
export function findConfig(from = process.cwd()): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const script = SCRIPT_FILES.find((name) => existsSync(join(dir, name)))
    const yaml = YAML_FILES.filter((name) => existsSync(join(dir, name)))
    const found = [...(script ? [script] : []), ...yaml]
    if (found.length > 1) {
      const where = fromCwd(dir) || '.'
      throw new UsageError(
        `${found.join(' and ')} are both in ${where}: reeval reads one config per directory. Keep one, or pass --config.`,
      )
    }
    if (found[0]) return join(dir, found[0])
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
 * path, every key takes its default and the current directory is the root. `reeval run` and
 * `reeval image build` refuse a missing file before this.
 */
export async function loadConfig(
  path: string | undefined,
  command = 'run',
  profile: string | undefined = undefined,
): Promise<ResolvedConfig> {
  if (path === undefined) return resolveConfig({}, process.cwd(), DEFAULT_CONFIG_FILE)
  const root = dirname(path)
  const configPath = configLabel(path)
  if (!existsSync(path)) throw new UsageError(`Config file not found: ${configPath}`)
  if (isYamlConfig(path)) {
    return resolveConfigData(
      parseYamlConfig(readFileSync(path, 'utf8'), configPath),
      root,
      configPath,
    )
  }
  const jiti = await reevalJiti(ownFileURL('dist/cli.js').href, { moduleCache: false })
  const module = (await jiti.import(path)) as Record<string, unknown>
  // Without this, a config that forgets `export default` would run the default harness for real.
  if (!module || typeof module !== 'object' || !('default' in module)) {
    const names = module && typeof module === 'object' ? Object.keys(module) : []
    const exportsNote = names.length ? ` (it exports ${names.join(', ')})` : ''
    throw new UsageError(
      `${configPath} has no default export${exportsNote}. Write export default defineConfig({…}).`,
    )
  }
  let exported = module.default as ConfigInput | Promise<ReevalConfig>
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
    throw new UsageError(
      `${configPath}'s default export must be defineConfig({…}) (got ${exported instanceof Promise ? 'a Promise' : JSON.stringify(exported)}). Write export default defineConfig({…}).`,
    )
  }
  return resolveConfig(exported, root, configPath)
}

/** A `reeval.yaml`'s text as data: an empty file is an empty config. */
export function parseYamlConfig(text: string, file: string): unknown {
  const doc = parseDocument(text, { prettyErrors: true })
  const [error] = doc.errors
  if (error) throw new UsageError(`${file} isn't valid YAML: ${error.message.trimEnd()}`)
  return doc.toJS() ?? {}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A config's Dockerfile that isn't there, named by its field. */
const missingIn =
  (file: string): MissingDockerfile =>
  (field, full) => {
    throw new UsageError(
      `${field} in ${file}: ${full} doesn't exist. Paths in ${file} are relative to its directory.`,
    )
  }

/**
 * The config with `sandbox` and each profile's `defaults.sandbox`, when written as data, given
 * absolute host paths against `root`. With `environments`, an environment written as data (a
 * `reeval.yaml`'s) gets its layers' paths resolved too; a script config's come from
 * `defineEnvironment`, which resolves them against its own file.
 */
function withHostPaths<T extends object>(
  config: T,
  root: string,
  file: string,
  { environments = false } = {},
): T {
  const missing = missingIn(file)
  const environment = (value: unknown, field: string) =>
    isRecord(value) && Array.isArray(value.layers)
      ? {
          ...value,
          layers: value.layers.map((layer, i) =>
            isRecord(layer)
              ? {
                  ...layer,
                  spec: specPaths(layer.spec, root, `${field}.layers[${i}].spec`, missing),
                }
              : layer,
          ),
        }
      : value
  const options = (value: unknown, prefix: string) => {
    if (!isRecord(value)) return value
    const out = { ...value }
    if ('sandbox' in value) {
      out.sandbox = sandboxPaths(value.sandbox, root, `${prefix}sandbox`, missing)
    }
    if (environments && 'environment' in value) {
      out.environment = environment(value.environment, `${prefix}environment`)
    }
    return out
  }
  const out = options(config, '') as Record<string, unknown>
  const { profiles } = out
  if (!isRecord(profiles)) return out as T
  const each = Object.entries(profiles).map(([name, profile]) =>
    isRecord(profile) && 'defaults' in profile
      ? [name, { ...profile, defaults: options(profile.defaults, `profiles.${name}.defaults.`) }]
      : [name, profile],
  )
  return { ...out, profiles: Object.fromEntries(each) } as T
}

/** The config from its data form: each environment's data becomes an `Environment` again. */
function configFromData(data: Record<string, unknown>): ReevalConfig {
  const withEnvironment = (options: unknown) => {
    if (!isObjectLike(options)) return options
    const { environment } = options
    return isEnvironment(environment)
      ? { ...options, environment: environmentFrom(environment) }
      : options
  }
  const config = withEnvironment(data) as Record<string, unknown>
  const { profiles } = config
  if (typeof profiles !== 'object' || profiles === null || Array.isArray(profiles)) return config
  const each = Object.entries(profiles).map(([name, profile]) => {
    if (!isObjectLike(profile)) return [name, profile]
    const { defaults } = profile
    return [
      name,
      defaults === undefined ? profile : { ...profile, defaults: withEnvironment(defaults) },
    ]
  })
  return { ...config, profiles: Object.fromEntries(each) }
}

/**
 * Resolves a config in its data form (a parsed `reeval.yaml`, or `ReevalConfigData` from another
 * language) whose relative host paths resolve against `root`, its directory: `resolveConfig`'s
 * checks name a mistake in their own words first, and the config contract refuses anything they
 * let through, such as a `null` or a misspelt nested key.
 */
export function resolveConfigData(input: unknown, root: string, file: string): ResolvedConfig {
  if (!isRecord(input)) {
    throw new UsageError(
      `${file} must be a mapping of config keys, like harness: and judge: (got ${JSON.stringify(input)})`,
    )
  }
  const data = withHostPaths(input, root, file, { environments: true })
  // `resolveConfig` would ask for `defineEnvironment(…)`, which a data config can't call.
  const { environment, profiles } = data as ReevalConfigData
  const environments = [
    environment,
    ...Object.values(typeof profiles === 'object' && profiles ? profiles : {}).map(
      (p) => (p as ProfileData | null)?.defaults?.environment,
    ),
  ]
  if (environments.some((e) => e !== undefined && !isEnvironment(e))) {
    const problem = configDataProblem(data, file)
    if (problem) throw new UsageError(problem)
  }
  let resolved: ResolvedConfig
  try {
    resolved = resolveConfig(configFromData(data), root, file)
  } catch (error) {
    if (error instanceof UsageError) throw error
    const problem = configDataProblem(data, file)
    if (problem) throw new UsageError(problem)
    throw error
  }
  const problem = configDataProblem(data, file)
  if (problem) throw new UsageError(problem)
  return resolved
}

const GLOB = /[*?[\]{}!]/

/** The directory every include pattern starts in: `evals/**\/*.eval.ts` → `evals`. */
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

const unknownKey = (value: object, allowed: string[], where: string, file: string) => {
  const key = Object.keys(value).find((k) => !allowed.includes(k))
  if (key === undefined) return
  const hints: Record<string, string> = {
    reuse: 'Reusing control results from .history isn’t built yet; every run runs its controls.',
    compare: 'compare only goes on a group or eval; a profile can narrow it with limit.compare.',
  }
  const near = closest(key, allowed)
  const hint = hints[key] ?? (near ? `Did you mean "${near}"?` : `Use ${allowed.join(', ')}.`)
  throw new UsageError(`Unknown option "${key}" in ${where} in ${file}. ${hint}`)
}

export function checkBudget(budget: unknown, where: string, file: string): Budget {
  if (budget === undefined) return {}
  if (typeof budget !== 'object' || budget === null) {
    throw new UsageError(
      `${where} in ${file} must be an object like { attempts: 20, duration: '1h' } (got ${JSON.stringify(budget)})`,
    )
  }
  if ('usd' in budget || 'tokens' in budget) {
    throw new UsageError(
      `${where}.${'usd' in budget ? 'usd' : 'tokens'} in ${file} isn't supported yet: reeval records the tokens harnesses report, but prices none and enforces no token budget. Cap the run with attempts or duration.`,
    )
  }
  unknownKey(budget, ['attempts', 'duration'], where, file)
  const { attempts, duration } = budget as Budget
  if (attempts !== undefined && !(Number.isInteger(attempts) && attempts >= 1)) {
    throw new UsageError(
      `${where}.attempts in ${file} must be a whole number of at least 1 (got ${JSON.stringify(attempts)})`,
    )
  }
  if (duration !== undefined) parseDuration(duration)
  return { ...(attempts ? { attempts } : {}), ...(duration ? { duration } : {}) }
}

const describeValue = (v: unknown) => {
  if (!isObjectLike(v)) return JSON.stringify(v)
  const { kind } = v
  if (kind === 'fake') return 'fakeHarness({ … })'
  return isAgentKind(kind) ? `${AGENTS[kind].factory}({ … })` : 'an object'
}

function checkProfile(name: string, profile: unknown, file: string): Profile {
  const where = `profiles.${name}`
  if (typeof profile !== 'object' || profile === null) {
    throw new UsageError(
      `${where} in ${file} must be an object of profile settings, e.g. { limit: { runs: 1 } } (got ${JSON.stringify(profile)})`,
    )
  }
  unknownKey(profile, PROFILE_KEYS, where, file)
  const p = profile as Profile
  if (p.defaults !== undefined) {
    unknownKey(p.defaults, DEFAULTS_KEYS, `${where}.defaults`, file)
    checkOptions(p.defaults, `${where}.defaults in ${file}`)
  }
  if (p.limit !== undefined) {
    unknownKey(p.limit, LIMIT_KEYS, `${where}.limit`, file)
    const { runs, compare, harness } = p.limit
    if (runs !== undefined && !(Number.isInteger(runs) && runs >= 1)) {
      throw new UsageError(
        `${where}.limit.runs in ${file} must be a whole number of at least 1 (got ${JSON.stringify(runs)})`,
      )
    }
    if (
      compare !== undefined &&
      compare !== false &&
      !(Number.isInteger(compare?.maxVariants) && compare.maxVariants >= 0)
    ) {
      throw new UsageError(
        `${where}.limit.compare in ${file} must be false or { maxVariants: n }, e.g. { maxVariants: 1 } (got ${JSON.stringify(compare)})`,
      )
    }
    if (harness !== undefined) {
      const bad = Array.isArray(harness) ? harness.find((h) => typeof h !== 'string') : harness
      if (bad !== undefined) {
        throw new UsageError(
          `${where}.limit.harness in ${file} can only list harness ids to allow (got ${describeValue(bad)}). To add harnesses, use ${where}.defaults.harness.`,
        )
      }
    }
  }
  if (
    p.tags !== undefined &&
    (!Array.isArray(p.tags) || p.tags.some((t) => typeof t !== 'string'))
  ) {
    throw new UsageError(
      `${where}.tags in ${file} must be a list of tag filters, e.g. tags: ['smoke'] (got ${JSON.stringify(p.tags)})`,
    )
  }
  if (p.record !== undefined && !RECORD.includes(p.record)) {
    throw new UsageError(
      `${where}.record in ${file} is ${oneOf(RECORD)} (got ${JSON.stringify(p.record)})`,
    )
  }
  if (p.judge !== undefined) resolveJudge(p.judge, file, `${where}.judge`)
  checkBudget(p.budget, `${where}.budget`, file)
  return p
}

/** `--profile`, then `REEVAL_PROFILE`, then `defaultProfile.ci` in CI (or `.local`), then none. */
export function selectProfile(
  config: ResolvedConfig,
  flag: string | undefined,
  env = process.env,
): ResolvedProfile | null {
  const pick = (): [string, string] | null => {
    if (flag) return [flag, '--profile']
    if (env.REEVAL_PROFILE) return [env.REEVAL_PROFILE, 'REEVAL_PROFILE']
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

/**
 * The config with its defaults filled in and checked; `root` is its directory, which relative
 * host paths written as data resolve against.
 */
export function resolveConfig(
  input: ReevalConfig,
  root: string,
  file: string = DEFAULT_CONFIG_FILE,
): ResolvedConfig {
  const user = withHostPaths(input, root, file)
  if ('compare' in user) {
    throw new UsageError(
      `compare can't be set in ${file}: it would multiply every eval. Put it on the group or eval that asks the question.`,
    )
  }
  checkOptions(user, file, CONFIG_KEYS)
  const include = user.include ?? ['evals/**/*.eval.ts']
  if (!Array.isArray(include) || include.some((p) => typeof p !== 'string')) {
    throw new UsageError(
      `include in ${file} must be a list of glob patterns, e.g. include: ['evals/**/*.eval.ts'] (got ${JSON.stringify(include)})`,
    )
  }
  const record = user.record ?? 'ci'
  if (!RECORD.includes(record)) {
    throw new UsageError(`record in ${file} is ${oneOf(RECORD)} (got ${JSON.stringify(record)})`)
  }
  const artifacts = user.history?.artifacts ?? 'all'
  if (!ARTIFACTS.includes(artifacts)) {
    throw new UsageError(
      `history.artifacts in ${file} is ${oneOf(ARTIFACTS)} (got ${JSON.stringify(artifacts)})`,
    )
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
      throw new UsageError(
        `profiles in ${file} must be an object of named profiles, e.g. profiles: { pr: { limit: { runs: 1 } } } (got ${JSON.stringify(user.profiles)})`,
      )
    }
    for (const [name, profile] of Object.entries(user.profiles)) {
      profiles[name] = checkProfile(name, profile, file)
    }
  }
  const defaultProfile = user.defaultProfile ?? {}
  unknownKey(defaultProfile, ['ci', 'local'], 'defaultProfile', file)
  for (const key of ['ci', 'local'] as const) {
    const name = defaultProfile[key]
    if (name !== undefined && !profiles[name]) {
      const names = Object.keys(profiles)
      throw new UsageError(
        `defaultProfile.${key} in ${file} names "${name}", which isn't a profile (${names.length ? `profiles: ${names.join(', ')}` : 'it defines none'}). Add it under profiles, or name one that's there.`,
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
    budget: checkBudget(user.budget, 'budget', file),
    profiles,
    defaultProfile,
    judge: resolveJudge(user.judge, file),
    capture: user.capture ?? {},
    timeoutMs: parseDuration(user.timeout ?? '15m'),
    concurrency:
      user.concurrency === undefined
        ? undefined
        : checkConcurrency(user.concurrency, `concurrency in ${file}`),
    record,
    history: { dir: historyDir, artifacts },
    secrets: checkSecrets(user.secrets, file),
    debug: checkDebug(user.debug, file),
    analysis: checkAnalysis(user.analysis, file),
  }
}

export const ANALYSIS_DEFAULTS = { maxInputTokens: 20_000, maxOutputTokens: 8_000 } as const

function checkAnalysis(
  analysis: ReevalConfig['analysis'],
  file: string,
): ResolvedConfig['analysis'] {
  if (analysis === undefined) return { ...ANALYSIS_DEFAULTS }
  if (typeof analysis !== 'object' || analysis === null) {
    throw new UsageError(
      `analysis in ${file} must be an object like { model: 'google/gemini-3.8-flash' } (got ${JSON.stringify(analysis)})`,
    )
  }
  unknownKey(
    analysis,
    ['model', 'agent', 'instructions', 'maxInputTokens', 'maxOutputTokens'],
    'analysis',
    file,
  )
  const {
    model,
    agent,
    instructions,
    maxInputTokens = ANALYSIS_DEFAULTS.maxInputTokens,
    maxOutputTokens = ANALYSIS_DEFAULTS.maxOutputTokens,
  } = analysis
  if (typeof model === 'string') {
    const problem = checkModelString(model, `analysis.model in ${file}`, [`google/${model}`])
    if (problem) throw new UsageError(problem)
  } else if (model !== undefined && !(isObjectLike(model) && model.kind === 'fake-analysis')) {
    throw new UsageError(
      `analysis.model in ${file} must be a 'provider/model' string, e.g. 'google/gemini-3.8-flash' (got ${JSON.stringify(model)})`,
    )
  }
  if (agent !== undefined && typeof agent !== 'boolean') {
    throw new UsageError(
      `analysis.agent in ${file} must be true or false (got ${JSON.stringify(agent)})`,
    )
  }
  if (instructions !== undefined && typeof instructions !== 'string') {
    throw new UsageError(
      `analysis.instructions in ${file} must be a string (got ${JSON.stringify(instructions)})`,
    )
  }
  if (!(Number.isInteger(maxInputTokens) && maxInputTokens >= 1000)) {
    throw new UsageError(
      `analysis.maxInputTokens in ${file} must be a whole number of at least 1000 (got ${maxInputTokens})`,
    )
  }
  if (!(Number.isInteger(maxOutputTokens) && maxOutputTokens >= 500)) {
    throw new UsageError(
      `analysis.maxOutputTokens in ${file} must be a whole number of at least 500 (got ${maxOutputTokens})`,
    )
  }
  return { ...analysis, maxInputTokens, maxOutputTokens }
}

/** Runs whose local debug data `.reeval/debug` keeps, and the trace buffer per attempt. */
export const DEBUG_DEFAULTS = { keep: 20, traceBufferMb: 8 } as const

function checkDebug(debug: ReevalConfig['debug'], file: string): ResolvedConfig['debug'] {
  if (debug === undefined) {
    return { keep: DEBUG_DEFAULTS.keep, traceBufferBytes: DEBUG_DEFAULTS.traceBufferMb * 2 ** 20 }
  }
  if (typeof debug !== 'object' || debug === null) {
    throw new UsageError(
      `debug in ${file} must be an object like { keep: 20, traceBufferMb: 8 } (got ${JSON.stringify(debug)})`,
    )
  }
  unknownKey(debug, ['keep', 'traceBufferMb'], 'debug', file)
  const { keep = DEBUG_DEFAULTS.keep, traceBufferMb = DEBUG_DEFAULTS.traceBufferMb } = debug
  if (!(Number.isInteger(keep) && keep >= 1)) {
    throw new UsageError(
      `debug.keep in ${file} must be a whole number of at least 1 (got ${JSON.stringify(keep)})`,
    )
  }
  if (!(typeof traceBufferMb === 'number' && traceBufferMb > 0)) {
    throw new UsageError(
      `debug.traceBufferMb in ${file} must be a number of megabytes above 0 (got ${JSON.stringify(traceBufferMb)})`,
    )
  }
  return { keep, traceBufferBytes: Math.round(traceBufferMb * 2 ** 20) }
}

function checkSecrets(secrets: ReevalConfig['secrets'], file: string): ResolvedConfig['secrets'] {
  if (secrets === undefined) return { unbrokered: 'warn' }
  if (typeof secrets !== 'object' || secrets === null) {
    throw new UsageError(
      `secrets in ${file} must be an object like { unbrokered: 'error' } (got ${JSON.stringify(secrets)})`,
    )
  }
  unknownKey(secrets, ['unbrokered'], 'secrets', file)
  const unbrokered = secrets.unbrokered ?? 'warn'
  if (unbrokered !== 'warn' && unbrokered !== 'error') {
    throw new UsageError(
      `secrets.unbrokered in ${file} is 'warn' or 'error' (got ${JSON.stringify(unbrokered)})`,
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

/** `--concurrency`, then `REEVAL_CONCURRENCY`, then `concurrency` in the config, then the default. */
export async function resolveConcurrency(
  config: ResolvedConfig,
  flag: string | undefined,
  capacity: () => Promise<Capacity>,
  env = process.env,
): Promise<number> {
  if (flag !== undefined) return checkConcurrency(flag, '--concurrency')
  if (env.REEVAL_CONCURRENCY) return checkConcurrency(env.REEVAL_CONCURRENCY, 'REEVAL_CONCURRENCY')
  return config.concurrency ?? defaultConcurrency(await capacity())
}

function resolveJudge(
  judge: ReevalConfig['judge'] | undefined,
  file: string,
  path = 'judge',
): ResolvedConfig['judge'] {
  judge ??= {}
  const problem = judgeProblem(judge, { at: 'config', path, file })
  if (problem) throw new UsageError(problem)
  const threshold = judge.threshold ?? DEFAULT_THRESHOLD
  return { ...judge, threshold }
}

/** Host variables that required `env` secrets read, as `[sandbox name, host name]`. */
export function secretSources(env: EnvVars): Array<[string, string]> {
  return Object.entries(env).flatMap(
    ([name, value]): Array<[string, string]> =>
      isSecret(value) && !value.optional ? [[name, value.from ?? name]] : [],
  )
}

/** The provider model `analysis.agent` calls during a run, if it's on: `analysis.model`, else the judge's. */
function agentModel(config: ResolvedConfig): string | null {
  if (!config.analysis.agent) return null
  const model = config.analysis.model ?? config.judge.model
  // An evaluation model can't analyse: the plan stops on that before it asks for keys.
  return typeof model === 'string' && !model.startsWith('typesafe-ai/') ? model : null
}

/** The run's judge model: the profile's when it sets one, else the config's. */
function runJudgeModel(config: ResolvedConfig, profile: ResolvedProfile | null | undefined) {
  return profile ? (profileJudge(profile).model ?? config.judge.model) : config.judge.model
}

/**
 * Names the environment variables the run's providers need but don't have: the harnesses it
 * plans (default: the config's), the run's judge, the models that answer compare questions,
 * the analysis model with `analysis.agent`, and required config and profile secrets.
 */
export function missingCredentials(
  config: ResolvedConfig,
  env = process.env,
  options: {
    harnesses?: HarnessDescriptor[]
    profile?: ResolvedProfile | null
    /** The `'provider/model'`s that answer compare questions. */
    questionModels?: string[]
  } = {},
): string[] {
  const missing: string[] = []
  const keys = new Set((options.harnesses ?? config.harness).flatMap((h) => credentialOf(h) ?? []))
  for (const key of keys) if (!env[key]) missing.push(key)
  const judge = runJudgeModel(config, options.profile)
  const agent = agentModel(config)
  const models = [
    ...(judge !== undefined ? [judge] : []),
    ...(options.questionModels ?? []),
    ...(agent ? [agent] : []),
  ]
  for (const model of models) {
    const modelKeys = judgeCredentials(model)
    const alternatives = modelKeys.join(' or ')
    if (modelKeys.length && !modelKeys.some((k) => env[k]) && !missing.includes(alternatives)) {
      missing.push(alternatives)
    }
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
 * Keys the run sends in request headers (the agents' credentials, the run's judge's and the
 * compare questions' models') whose value has
 * whitespace or a control character in it, with where the first one is: a key pasted from a
 * wrapped terminal line picks up a line break, and the agent then hangs on a request it can't send
 * rather than failing to authenticate.
 */
export function malformedCredentials(
  config: ResolvedConfig,
  env = process.env,
  options: {
    harnesses?: HarnessDescriptor[]
    profile?: ResolvedProfile | null
    questionModels?: string[]
  } = {},
): string[] {
  const names = (options.harnesses ?? config.harness).flatMap((h) => credentialOf(h) ?? [])
  const judge = runJudgeModel(config, options.profile)
  if (judge !== undefined) names.push(...judgeCredentials(judge))
  for (const model of options.questionModels ?? []) names.push(...judgeCredentials(model))
  const analyst = agentModel(config)
  if (analyst) names.push(...judgeCredentials(analyst))
  return [...new Set(names)].flatMap((name) => {
    const at = badCharacterAt(env[name] ?? '')
    return at ? [`${name} (character ${at})`] : []
  })
}
