import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createJiti } from 'jiti'
import { cursor } from './harness.ts'
import {
  checkModelString,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_THRESHOLD,
  judgeCredentials,
} from './judge/index.ts'
import { docker } from './sandbox.ts'
import type { ConfigContext, Duration, EsConfig, ResolvedConfig } from './types.ts'

export class UsageError extends Error {
  override name = 'UsageError'
}

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
  const include = user.include ?? ['evals/**/*.es.ts']
  if (!Array.isArray(include) || include.some((p) => typeof p !== 'string')) {
    throw new UsageError('config.include must be an array of glob strings')
  }
  const harness = user.harness ?? cursor()
  if (!['fake', 'cursor'].includes(harness.kind)) {
    throw new UsageError(`Unknown harness "${(harness as { kind: string }).kind}"`)
  }
  const sandbox = user.sandbox ?? docker()
  if (!['fake', 'docker'].includes(sandbox.kind)) {
    throw new UsageError(`Unknown sandbox "${(sandbox as { kind: string }).kind}"`)
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
  return {
    root,
    include,
    harness,
    sandbox,
    judge: resolveJudge(user.judge),
    timeoutMs: parseDuration(user.timeout ?? '15m'),
    record,
    history: { dir: historyDir, artifacts },
  }
}

function resolveJudge(judge: EsConfig['judge'] = {}): ResolvedConfig['judge'] {
  const model = judge.model ?? DEFAULT_JUDGE_MODEL
  if (typeof model === 'string') {
    const problem = checkModelString(model)
    if (problem) throw new UsageError(`config.judge: ${problem}`)
  } else if (typeof model !== 'object' || model?.kind !== 'fake-judge') {
    throw new UsageError(
      'config.judge.model must be a "provider/model" string or fakeJudge(). ' +
        'Pass model objects per group, eval or call instead.',
    )
  }
  const threshold = judge.threshold ?? DEFAULT_THRESHOLD
  if (!(threshold >= 0 && threshold <= 1)) {
    throw new UsageError('config.judge.threshold must be between 0 and 1')
  }
  return { ...judge, model, threshold }
}

/** Names the environment variables the configured providers need but don't have. */
export function missingCredentials(config: ResolvedConfig, env = process.env): string[] {
  const missing: string[] = []
  if (config.harness.kind === 'cursor' && !env.CURSOR_API_KEY) missing.push('CURSOR_API_KEY')
  const judgeKeys = judgeCredentials(config.judge.model)
  if (judgeKeys.length && !judgeKeys.some((k) => env[k])) missing.push(judgeKeys.join(' or '))
  return missing
}
