// The options cascade shared by the config, groups and evals, and the matrix ids derived from it.

import { isSecret } from './environment.ts'
import { UsageError } from './errors.ts'
import { SECRET_NAME } from './redact.ts'
import type {
  Axis,
  Cell,
  Duration,
  Environment,
  EnvVars,
  EvalOptions,
  HarnessDescriptor,
  JudgeOptions,
  SandboxDescriptor,
} from './types.ts'

const KNOWN = ['harness', 'sandbox', 'environment', 'runs', 'env', 'judge', 'timeout', 'tags']
const SUGGEST: Record<string, string> = {
  harnesses: 'harness',
  sandboxes: 'sandbox',
  environments: 'environment',
  repeat: 'runs',
  repeats: 'runs',
  iterations: 'runs',
  trials: 'runs',
  secrets: 'env',
  vars: 'env',
  tag: 'tags',
}

const VAR = /^[A-Za-z_][A-Za-z0-9_]*$/
const ID = /^[A-Za-z0-9._:@-]+$/

const sanitize = (text: string) =>
  (text.split('/').at(-1) ?? text).replace(/[^A-Za-z0-9._:@-]+/g, '-')

export function harnessId(h: HarnessDescriptor): string {
  if (h.id) return h.id
  if (h.kind === 'cursor') return h.model ? `cursor:${sanitize(h.model)}` : 'cursor'
  return 'fake'
}

export function sandboxId(s: SandboxDescriptor): string {
  if (s.id) return s.id
  if (s.kind === 'fake') return 'fake'
  const image = s.image ?? s.from
  return image ? `docker:${sanitize(image)}` : 'docker'
}

export const cellKey = (harness: string, environment: string, sandbox: string) =>
  `${harness}/${environment}/${sandbox}`

/** Throws on keys that aren't options, suggesting the likely one. */
export function checkOptions(options: object, where: string, allowed = KNOWN): void {
  for (const key of Object.keys(options)) {
    if (allowed.includes(key)) continue
    const hint = SUGGEST[key] ? ` Did you mean "${SUGGEST[key]}"?` : ''
    throw new UsageError(`Unknown option "${key}" in ${where}.${hint}`)
  }
  const { runs, tags, env } = options as EvalOptions
  if (runs !== undefined && !(Number.isInteger(runs) && runs >= 1)) {
    throw new UsageError(`runs must be a whole number of at least 1 (got ${runs}) in ${where}`)
  }
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string'))) {
    throw new UsageError(`tags must be a list of strings in ${where}`)
  }
  if (env !== undefined) checkEnv(env, where)
}

export function checkEnv(env: EnvVars, where: string): void {
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    throw new UsageError(`env must be an object of variables in ${where}`)
  }
  for (const [name, value] of Object.entries(env)) {
    if (!VAR.test(name)) throw new UsageError(`env.${name} in ${where} isn't a valid variable name`)
    if (isSecret(value)) continue
    if (typeof value !== 'string') {
      throw new UsageError(`env.${name} in ${where} must be a string or secret()`)
    }
    if (SECRET_NAME.test(name)) {
      throw new UsageError(
        `env.${name} in ${where} is a literal string. Pass secrets with secret() so they're redacted and never recorded.`,
      )
    }
  }
}

function checkAxisValue(
  kind: 'harness' | 'sandbox' | 'environment',
  value: unknown,
  where: string,
) {
  const v = value as { kind?: string }
  const ok =
    kind === 'environment'
      ? v?.kind === 'environment'
      : kind === 'harness'
        ? v?.kind === 'cursor' || v?.kind === 'fake'
        : v?.kind === 'docker' || v?.kind === 'fake'
  if (ok) return
  const example = { harness: 'cursor()', sandbox: 'docker()', environment: 'defineEnvironment(…)' }[
    kind
  ]
  throw new UsageError(`${kind} in ${where} must be like ${example} (got ${JSON.stringify(value)})`)
}

function applyAxis<T>(
  kind: 'harness' | 'sandbox' | 'environment',
  inherited: T[],
  value: Axis<T> | undefined,
  where: string,
): T[] {
  if (value === undefined) return inherited
  const next = typeof value === 'function' ? (value as (i: T[]) => T | T[])(inherited) : value
  const list = Array.isArray(next) ? next : [next]
  if (list.length === 0) {
    const example = { harness: 'cursor()', sandbox: 'docker()', environment: 'baseline' }[kind]
    throw new UsageError(
      `${kind} is an empty list in ${where}. Give at least one, e.g. ${kind}: ${example}`,
    )
  }
  for (const item of list) checkAxisValue(kind, item, where)
  return list
}

function checkUnique<T>(kind: string, list: T[], id: (t: T) => string, where: string, fix: string) {
  const seen = new Set<string>()
  for (const item of list) {
    const key = id(item)
    if (!ID.test(key)) {
      throw new UsageError(
        `The ${kind} id "${key}" in ${where} may only use letters, digits and . _ : @ -`,
      )
    }
    if (seen.has(key)) {
      throw new UsageError(`Two ${kind}s in ${where} resolve to the id "${key}". ${fix}`)
    }
    seen.add(key)
  }
}

export type Level = { options: EvalOptions; where: string }

export type Resolved = {
  harness: HarnessDescriptor[]
  sandbox: SandboxDescriptor[]
  environment: Environment[]
  runs: number
  env: EnvVars
  judge: JudgeOptions
  timeout: Duration | undefined
  tags: string[]
}

/** Config, then each enclosing group, then the eval: axes replace, `env` and `judge` merge, tags add up. */
export function cascade(
  base: Resolved,
  levels: Level[],
  where: string,
  runsOverride?: number,
): Resolved {
  const out: Resolved = {
    ...base,
    env: { ...base.env },
    judge: { ...base.judge },
    tags: [...base.tags],
  }
  for (const { options, where: at } of levels) {
    out.harness = applyAxis('harness', out.harness, options.harness, at)
    out.sandbox = applyAxis('sandbox', out.sandbox, options.sandbox, at)
    out.environment = applyAxis('environment', out.environment, options.environment, at)
    if (options.runs !== undefined) out.runs = options.runs
    if (options.timeout !== undefined) out.timeout = options.timeout
    Object.assign(out.env, options.env)
    Object.assign(out.judge, options.judge)
    for (const tag of options.tags ?? []) if (!out.tags.includes(tag)) out.tags.push(tag)
  }
  if (runsOverride !== undefined) out.runs = runsOverride
  checkUnique(
    'harness',
    out.harness,
    harnessId,
    where,
    "Give one an id, e.g. cursor({ model: '…', id: '…' })",
  )
  checkUnique(
    'sandbox',
    out.sandbox,
    sandboxId,
    where,
    "Give one an id, e.g. docker({ from: '…', id: '…' })",
  )
  checkUnique(
    'environment',
    out.environment,
    (e) => e.name,
    where,
    'Environment names must be unique.',
  )
  return out
}

export type PlannedAttempt = {
  cell: Cell
  harness: HarnessDescriptor
  sandbox: SandboxDescriptor
  environment: Environment
  n: number
  label: string
}

/** Harness, then environment, then sandbox, then run number. */
export function expand(resolved: Resolved): PlannedAttempt[] {
  const vary = {
    harness: resolved.harness.length > 1,
    environment: resolved.environment.length > 1,
    sandbox: resolved.sandbox.length > 1,
  }
  const attempts: PlannedAttempt[] = []
  for (const harness of resolved.harness) {
    for (const environment of resolved.environment) {
      for (const sandbox of resolved.sandbox) {
        const ids = {
          harness: harnessId(harness),
          environment: environment.name,
          sandbox: sandboxId(sandbox),
        }
        const cell: Cell = { key: cellKey(ids.harness, ids.environment, ids.sandbox), ...ids }
        const axes = (['harness', 'environment', 'sandbox'] as const)
          .filter((a) => vary[a])
          .map((a) => ids[a])
        for (let n = 1; n <= resolved.runs; n++) {
          const label = [axes.join(' · '), resolved.runs > 1 ? `#${n}` : '']
            .filter(Boolean)
            .join(' ')
          attempts.push({ cell, harness, sandbox, environment, n, label })
        }
      }
    }
  }
  return attempts
}

/** `--tag a --tag !b`: every entry must hold. */
export function matchesTags(tags: string[], filters: string[]): boolean {
  return filters.every((f) => (f.startsWith('!') ? !tags.includes(f.slice(1)) : tags.includes(f)))
}
