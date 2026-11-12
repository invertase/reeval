// Picks how `reeval run` prints, following Turborepo's flag names and defaults where they fit
// (`--log-order`, `--log-prefix`, `--output-logs`) and its CI detection.
import { UsageError } from '../config.ts'
import { isOneOf } from '../object.ts'

export type UiMode = 'plain' | 'agent'
/** `stream` prints every line as it happens; `grouped` prints each attempt as one block. */
export type LogOrder = 'stream' | 'grouped'
export type LogPrefix = 'task' | 'none'
/** Which attempts get their detail lines: all, failing ones only, or none. */
export type OutputLogs = 'full' | 'errors-only' | 'none'

export type OutputOptions = {
  mode: UiMode
  /** A status line under the output: on a TTY outside CI, unless `--ui` named the mode. */
  statusLine: boolean
  /**
   * The status list you can browse with the arrow keys, during the run and after it: where the
   * status line would be, with a TTY to read keys from and no attempt logs asked for.
   */
  interactive: boolean
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
  /** `-v` or `-vv`: their phase trace prints as detail lines, so they default to `full`. */
  verbose?: boolean
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
  if (value === 'auto' || isOneOf(allowed, value)) return value
  throw new UsageError(`${name} is one of ${[...allowed, 'auto'].join(', ')} (got ${value})`)
}

/**
 * A heartbeat variable's interval in ms: a bare number is seconds; unset or empty is `fallback`.
 * With `range`, an interval other than 0 must be within it.
 */
export function parseHeartbeat(
  name: string,
  value: string | undefined,
  fallback: number,
  range?: { min: number; max: number; says: string },
): number {
  if (!value) return fallback
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(value)
  const unit = { ms: 1, s: 1000, m: 60_000 }[match?.[2] ?? 's'] ?? 1000
  const ms = match ? Number(match[1]) * unit : Number.NaN
  if (range && ms !== 0 && !(ms >= range.min && ms <= range.max)) {
    throw new UsageError(
      `${name} must be 0 for none or a duration from ${range.says} (got ${value})`,
    )
  }
  if (!match)
    throw new UsageError(`${name} must be a duration like 30s, or 0 for none (got ${value})`)
  return ms
}

export function resolveOutput(input: {
  flags: OutputFlags
  env: NodeJS.ProcessEnv
  isTTY: boolean
  /** The coding agent running us, from std-env's `detectAgent()`. */
  agent: string | undefined
  /** Whether stdin is a TTY, which the interactive list reads keys from. */
  stdinTTY?: boolean
}): OutputOptions {
  const { flags, env } = input
  const ci = isCI(env)
  const githubActions = set(env, 'GITHUB_ACTIONS')

  const ui = pick('--ui', flags.ui ?? env.REEVAL_UI, ['plain', 'agent'] as const)
  const named = ui !== undefined && ui !== 'auto'
  const mode: UiMode = named ? ui : input.agent ? 'agent' : 'plain'
  const statusLine = !named && mode === 'plain' && !ci && input.isTTY

  const order = pick('--log-order', flags.logOrder ?? env.REEVAL_LOG_ORDER, [
    'stream',
    'grouped',
  ] as const)
  const logOrder: LogOrder = order && order !== 'auto' ? order : ci ? 'grouped' : 'stream'

  // As in Turborepo, GitHub Actions' group headers name the attempt, so lines inside drop it.
  const prefix = pick('--log-prefix', flags.logPrefix ?? env.REEVAL_LOG_PREFIX, [
    'task',
    'none',
  ] as const)
  const logPrefix: LogPrefix =
    prefix && prefix !== 'auto' ? prefix : githubActions && logOrder === 'grouped' ? 'none' : 'task'

  const logs = pick('--output-logs', flags.outputLogs ?? env.REEVAL_OUTPUT_LOGS, [
    'full',
    'errors-only',
    'none',
  ] as const)
  // The status list at the end says how each eval went, so attempt logs print only when asked for.
  const outputLogs: OutputLogs = logs && logs !== 'auto' ? logs : flags.verbose ? 'full' : 'none'

  // GitHub Actions renders ANSI color even though stdout isn't a TTY.
  const color = env.NO_COLOR
    ? false
    : env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== ''
      ? set(env, 'FORCE_COLOR')
      : mode === 'agent'
        ? false
        : input.isTTY || githubActions

  return {
    mode,
    statusLine,
    interactive: statusLine && !!input.stdinTTY && outputLogs === 'none',
    logOrder,
    logPrefix,
    outputLogs,
    color,
    githubActions,
    heartbeatMs:
      mode === 'agent' ? 0 : parseHeartbeat('REEVAL_HEARTBEAT', env.REEVAL_HEARTBEAT, 60_000),
  }
}
