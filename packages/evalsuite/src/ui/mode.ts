// Picks how `es run` prints, following Turborepo's flag names and defaults where they fit
// (`--log-order`, `--log-prefix`, `--output-logs`) and its CI detection.
import { UsageError } from '../config.ts'

/** `live` redraws a block on a TTY; `plain` appends lines; `agent` prints failures only. */
export type UiMode = 'live' | 'plain' | 'agent'
/** `stream` prints every line as it happens; `grouped` prints each attempt as one block. */
export type LogOrder = 'stream' | 'grouped'
export type LogPrefix = 'task' | 'none'
/** Which attempts get their detail lines: all, failing ones only, or none. */
export type OutputLogs = 'full' | 'errors-only' | 'none'

export type OutputOptions = {
  /** What was asked for; `live` renders as `plain` until the live renderer lands. */
  requested: UiMode
  mode: Exclude<UiMode, 'live'>
  logOrder: LogOrder
  logPrefix: LogPrefix
  outputLogs: OutputLogs
  color: boolean
  /** `::group::` blocks and `::error::` annotations. */
  githubActions: boolean
  /** A "still running" line after this much silence; 0 turns it off. */
  heartbeatMs: number
}

export type OutputFlags = {
  ui?: string
  logOrder?: string
  logPrefix?: string
  outputLogs?: string
}

const set = (env: NodeJS.ProcessEnv, name: string) => {
  const value = env[name]
  return !!value && value !== 'false' && value !== '0'
}

// Turborepo's list (crates/turborepo-ci): any of these set means CI.
const CI_VARS = [
  'BUILD_ID',
  'BUILD_NUMBER',
  'CI',
  'CI_APP_ID',
  'CI_BUILD_ID',
  'CI_BUILD_NUMBER',
  'CI_NAME',
  'CONTINUOUS_INTEGRATION',
  'RUN_ID',
  'TEAMCITY_VERSION',
  'GITHUB_ACTIONS',
]

export const isCI = (env: NodeJS.ProcessEnv): boolean => CI_VARS.some((name) => set(env, name))

function pick<T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
): T | 'auto' | undefined {
  if (value === undefined || value === '') return undefined
  if (value === 'auto' || (allowed as readonly string[]).includes(value)) return value as T | 'auto'
  throw new UsageError(`${name} must be one of ${[...allowed, 'auto'].join(', ')}`)
}

function parseHeartbeat(value: string | undefined): number {
  if (!value) return 60_000
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(value)
  if (!match) throw new UsageError(`ES_HEARTBEAT must be a duration like 30s or 0`)
  const unit = { ms: 1, s: 1000, m: 60_000 }[match[2] ?? 's'] ?? 1000
  return Number(match[1]) * unit
}

export function resolveOutput(input: {
  flags: OutputFlags
  env: NodeJS.ProcessEnv
  isTTY: boolean
  /** The coding agent running us, from std-env's `detectAgent()`. */
  agent: string | undefined
}): OutputOptions {
  const { flags, env } = input
  const ci = isCI(env)
  const githubActions = set(env, 'GITHUB_ACTIONS')

  const ui = pick('--ui', flags.ui ?? env.ES_UI, ['live', 'plain', 'agent'] as const)
  const requested: UiMode =
    ui && ui !== 'auto' ? ui : input.agent ? 'agent' : ci || !input.isTTY ? 'plain' : 'live'
  const mode = requested === 'live' ? 'plain' : requested

  const order = pick('--log-order', flags.logOrder ?? env.ES_LOG_ORDER, [
    'stream',
    'grouped',
  ] as const)
  const logOrder: LogOrder = order && order !== 'auto' ? order : ci ? 'grouped' : 'stream'

  // As in Turborepo, GitHub Actions' group headers name the attempt, so lines inside drop it.
  const prefix = pick('--log-prefix', flags.logPrefix ?? env.ES_LOG_PREFIX, [
    'task',
    'none',
  ] as const)
  const logPrefix: LogPrefix =
    prefix && prefix !== 'auto' ? prefix : githubActions && logOrder === 'grouped' ? 'none' : 'task'

  const logs = pick('--output-logs', flags.outputLogs ?? env.ES_OUTPUT_LOGS, [
    'full',
    'errors-only',
    'none',
  ] as const)
  const outputLogs: OutputLogs = logs && logs !== 'auto' ? logs : 'full'

  // GitHub Actions renders ANSI colour even though stdout isn't a TTY.
  const color = env.NO_COLOR
    ? false
    : env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== ''
      ? set(env, 'FORCE_COLOR')
      : mode === 'agent'
        ? false
        : input.isTTY || githubActions

  return {
    requested,
    mode,
    logOrder,
    logPrefix,
    outputLogs,
    color,
    githubActions,
    heartbeatMs: mode === 'agent' ? 0 : parseHeartbeat(env.ES_HEARTBEAT),
  }
}
