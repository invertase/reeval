import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createJiti } from 'jiti'
import { cursor } from './harness.ts'
import { docker } from './sandbox.ts'
import type { Duration, EsConfig, ResolvedConfig } from './types.ts'

export class UsageError extends Error {
  override name = 'UsageError'
}

export const defineConfig = (config: EsConfig): EsConfig => config

const UNITS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const

export function parseDuration(value: Duration): number {
  if (typeof value === 'number') return value
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value)
  if (!match) throw new UsageError(`Invalid duration "${value}". Use e.g. "90s" or "15m".`)
  return Number(match[1]) * UNITS[match[2] as keyof typeof UNITS]
}

export const DEFAULT_JUDGE_MODEL = 'gemini-3.8-flash'

export async function loadConfig(configPath: string): Promise<ResolvedConfig> {
  const path = resolve(configPath)
  const root = dirname(path)
  let user: EsConfig = {}
  if (existsSync(path)) {
    const jiti = createJiti(import.meta.url, { moduleCache: false })
    user = (await jiti.import(path, { default: true })) as EsConfig
    if (!user || typeof user !== 'object') {
      throw new UsageError(`${configPath} must default-export defineConfig({...})`)
    }
  } else if (configPath !== 'es.config.ts') {
    throw new UsageError(`Config file not found: ${configPath}`)
  }
  return resolveConfig(user, root)
}

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
  return {
    root,
    include,
    harness,
    sandbox,
    judge: { model: user.judge?.model ?? DEFAULT_JUDGE_MODEL, fake: user.judge?.fake },
    timeoutMs: parseDuration(user.timeout ?? '15m'),
  }
}

/** Names the environment variables the configured providers need but don't have. */
export function missingCredentials(config: ResolvedConfig, env = process.env): string[] {
  if (config.harness.kind === 'fake') return []
  const missing: string[] = []
  if (!env.CURSOR_API_KEY) missing.push('CURSOR_API_KEY')
  if (!config.judge.fake && !env.GOOGLE_GENERATIVE_AI_API_KEY) {
    missing.push('GOOGLE_GENERATIVE_AI_API_KEY')
  }
  return missing
}
