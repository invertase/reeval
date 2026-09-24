import { existsSync } from 'node:fs'
import { availableParallelism, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createJiti } from 'jiti'
import { baseline, isSecret } from './environment.ts'
import { UsageError } from './errors.ts'
import { cursor } from './harness.ts'
import { checkModelString, DEFAULT_THRESHOLD, judgeCredentials } from './judge/index.ts'
import { cascade, checkOptions } from './options.ts'
import { docker } from './sandbox.ts'
import type { ConfigContext, Duration, EnvVars, EsConfig, ResolvedConfig } from './types.ts'

export { UsageError }

const CONFIG_KEYS = [
  'include',
  'harness',
  'sandbox',
  'environment',
  'runs',
  'env',
  'judge',
  'timeout',
  'concurrency',
  'record',
  'history',
]

export type ConfigInput = EsConfig | ((ctx: ConfigContext) => EsConfig | Promise<EsConfig>)

export const defineConfig = <T extends ConfigInput>(config: T): T => config

const UNITS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const

export function parseDuration(value: Duration): number {
  if (typeof value === 'number') return value
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value)
  if (!match) throw new UsageError(`Invalid duration "${value}". Use e.g. "90s" or "15m".`)
  return Number(match[1]) * UNITS[match[2] as keyof typeof UNITS]
}

export async function loadConfig(configPath: string, command = 'run'): Promise<ResolvedConfig> {
  const path = resolve(configPath)
  const root = dirname(path)
  let user: EsConfig = {}
  if (existsSync(path)) {
    const jiti = createJiti(import.meta.url, { moduleCache: false })
    let exported = (await jiti.import(path, { default: true })) as ConfigInput
    if (typeof exported === 'function') {
      const env = process.env
      exported = await exported({ ci: !!env.CI && env.CI !== 'false', command, env })
    }
    if (!exported || typeof exported !== 'object') {
      throw new UsageError(`${configPath} must default-export defineConfig({...})`)
    }
    user = exported
  } else if (configPath !== 'es.config.ts') {
    throw new UsageError(`Config file not found: ${configPath}`)
  }
  return resolveConfig(user, root)
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

export function resolveConfig(user: EsConfig, root: string): ResolvedConfig {
  checkOptions(user, 'es.config.ts', CONFIG_KEYS)
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
  const defaults = {
    harness: [cursor()],
    sandbox: [docker()],
    environment: [baseline],
    runs: 1,
    env: {},
    judge: {},
    timeout: undefined,
    tags: [],
  }
  const { harness, sandbox, environment, runs, env } = cascade(
    defaults,
    [{ options: { ...user, judge: undefined, timeout: undefined }, where: 'es.config.ts' }],
    'es.config.ts',
  )
  return {
    root,
    include,
    harness,
    sandbox,
    environment,
    runs,
    env,
    judge: resolveJudge(user.judge),
    timeoutMs: parseDuration(user.timeout ?? '15m'),
    concurrency:
      user.concurrency === undefined
        ? undefined
        : checkConcurrency(user.concurrency, 'config.concurrency'),
    record,
    history: { dir: historyDir, artifacts },
  }
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

function resolveJudge(judge: EsConfig['judge'] = {}): ResolvedConfig['judge'] {
  const { model } = judge
  if (typeof model === 'string') {
    const problem = checkModelString(model)
    if (problem) throw new UsageError(`config.judge: ${problem}`)
  } else if (model !== undefined && (typeof model !== 'object' || model?.kind !== 'fake-judge')) {
    throw new UsageError(
      'config.judge.model must be a "provider/model" string or fakeJudge(). ' +
        'Pass model objects per group, eval or call instead.',
    )
  }
  const threshold = judge.threshold ?? DEFAULT_THRESHOLD
  if (!(threshold >= 0 && threshold <= 1)) {
    throw new UsageError('config.judge.threshold must be between 0 and 1')
  }
  return { ...judge, threshold }
}

/** Host variables that `env` secrets read, as `[sandbox name, host name]`. */
export function secretSources(env: EnvVars): Array<[string, string]> {
  return Object.entries(env).flatMap(([name, value]) =>
    isSecret(value) ? [[name, value.from ?? name] as [string, string]] : [],
  )
}

/** Names the environment variables the configured providers need but don't have. */
export function missingCredentials(config: ResolvedConfig, env = process.env): string[] {
  const missing: string[] = []
  if (config.harness.some((h) => h.kind === 'cursor') && !env.CURSOR_API_KEY) {
    missing.push('CURSOR_API_KEY')
  }
  if (config.judge.model !== undefined) {
    const judgeKeys = judgeCredentials(config.judge.model)
    if (judgeKeys.length && !judgeKeys.some((k) => env[k])) missing.push(judgeKeys.join(' or '))
  }
  for (const [name, from] of secretSources(config.env)) {
    if (!env[from]) missing.push(from === name ? name : `${from} (for ${name})`)
  }
  return missing
}
