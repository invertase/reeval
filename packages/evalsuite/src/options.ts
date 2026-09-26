// The options cascade shared by the config, profiles, groups and evals, and the cells it expands to.

import { egressLabel, plannedEgress } from './egress.ts'
import {
  type AppliedEnvironment,
  applied,
  checkEgress,
  checkEnv,
  isEnvironment,
  isMovingRef,
  layered,
  plannedSecrets,
  type UnbrokeredSecret,
  unbrokeredSecrets,
} from './environment.ts'
import { UsageError } from './errors.ts'
import { HARNESS_EXAMPLE, isAgentKind } from './harness/agents.ts'
import type {
  Cell,
  CellGate,
  CompareGate,
  Duration,
  EgressPolicy,
  Environment,
  EnvVars,
  EvalOptions,
  EvalPlan,
  GatePolicy,
  HarnessDescriptor,
  JudgeOptions,
  PinnableKey,
  PlannedEgress,
  ResolvedProfile,
  SandboxDescriptor,
} from './types.ts'

const KNOWN = [
  'harness',
  'sandbox',
  'environment',
  'compare',
  'runs',
  'gate',
  'env',
  'egress',
  'judge',
  'timeout',
  'tags',
  'pin',
]
const SUGGEST: Record<string, string> = {
  harnesses: 'harness',
  sandboxes: 'sandbox',
  environments: 'environment',
  baseline: 'environment',
  variants: 'compare',
  repeat: 'runs',
  repeats: 'runs',
  iterations: 'runs',
  trials: 'runs',
  secrets: 'env',
  vars: 'env',
  network: 'egress',
  networkPolicy: 'egress',
  tag: 'tags',
  pins: 'pin',
  passRate: 'gate',
  threshold: 'gate',
}

/** Throws unless `value` is `'all'` or `{ passRate }` with a rate in (0, 1]. */
export function checkGate(value: unknown, where: string): void {
  if (value === 'all') return
  const rate = (value as { passRate?: unknown })?.passRate
  const keys = typeof value === 'object' && value !== null ? Object.keys(value) : []
  if (keys.length === 1 && typeof rate === 'number' && rate > 0 && rate <= 1) return
  throw new UsageError(
    `gate is 'all' (every attempt passes) or { passRate } with a share above 0 and at most 1, e.g. gate: { passRate: 0.8 } (got ${JSON.stringify(value)}) in ${where}`,
  )
}
const PINNABLE: PinnableKey[] = ['harness', 'runs', 'compare']
const GATES: CompareGate[] = ['variants', 'all', 'none']

const ID = /^[A-Za-z0-9._:@+-]+$/

const sanitize = (text: string) =>
  (text.split('/').at(-1) ?? text).replace(/[^A-Za-z0-9._:@-]+/g, '-')

export function harnessId(h: HarnessDescriptor): string {
  if (h.id) return h.id
  if (h.kind === 'fake') return 'fake'
  return h.model ? `${h.kind}:${sanitize(h.model)}` : h.kind
}

export function sandboxId(s: SandboxDescriptor): string {
  if (s.id) return s.id
  if (s.kind === 'fake') return 'fake'
  if (s.dockerfile) {
    const [file = '', dir = ''] = s.dockerfile.split(/[\\/]/).reverse()
    return `docker:${sanitize(file === 'Dockerfile' ? dir || file : file)}`
  }
  const image = s.image ?? s.from
  return image ? `docker:${sanitize(image)}` : 'docker'
}

export const cellKey = (harness: string, environment: string, sandbox: string) =>
  `${harness}/${environment}/${sandbox}`

const isHarness = (v: unknown) =>
  (v as { kind?: string })?.kind === 'fake' || isAgentKind((v as { kind?: string })?.kind)
const isSandbox = (v: unknown) =>
  (v as { kind?: string })?.kind === 'docker' || (v as { kind?: string })?.kind === 'fake'

function checkMaxConcurrent(value: unknown, where: string): void {
  if (value === undefined || (Number.isInteger(value) && (value as number) >= 1)) return
  throw new UsageError(
    `maxConcurrent must be a whole number of at least 1 (got ${String(value)}) for ${where}`,
  )
}

const describe = (value: unknown) => {
  if (Array.isArray(value)) return `a list of ${value.length}`
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value)
    return keys.length ? `an object with ${keys.map((k) => `"${k}"`).join(', ')}` : 'an object'
  }
  return JSON.stringify(value) ?? String(value)
}

function checkCompare(value: unknown, where: string): void {
  if (value === false) return
  const variants = Array.isArray(value) ? value : (value as { variants?: unknown })?.variants
  if (!Array.isArray(value)) {
    if (typeof value !== 'object' || value === null || !Array.isArray(variants)) {
      throw new UsageError(
        `compare takes environments (got ${describe(value)}) in ${where}. Use compare: [a, b], or { variants: [a, b], gate?, minLift?, harness? }.`,
      )
    }
    for (const key of Object.keys(value)) {
      if (!['variants', 'gate', 'minLift', 'harness'].includes(key)) {
        throw new UsageError(`Unknown compare option "${key}" in ${where}`)
      }
    }
    const { gate, minLift, harness } = value as {
      gate?: unknown
      minLift?: unknown
      harness?: unknown
    }
    if (gate !== undefined && !GATES.includes(gate as CompareGate)) {
      throw new UsageError(`compare.gate must be one of ${GATES.join(', ')} in ${where}`)
    }
    if (minLift !== undefined && !(typeof minLift === 'number' && minLift >= -1 && minLift <= 1)) {
      throw new UsageError(`compare.minLift is points from -1 to 1 (got ${minLift}) in ${where}`)
    }
    if (harness !== undefined && !Array.isArray(harness)) {
      throw new UsageError(`compare.harness must be a list of harness ids in ${where}`)
    }
  }
  if ((variants as unknown[]).length === 0) {
    throw new UsageError(`compare has no variants in ${where}. Give at least one environment.`)
  }
  for (const v of variants as unknown[]) {
    if (v === undefined) {
      throw new UsageError(
        `compare lists undefined in ${where}. evalsuite has no baseline: the inherited environment is the control of compare; with none, the control is empty.`,
      )
    }
    if (!isEnvironment(v)) {
      throw new UsageError(
        `compare takes environments (got ${describe(v)}) in ${where}. Variants share the eval's prompt and checks; if a variant needs different checks, write a separate eval.`,
      )
    }
  }
}

/** Throws on keys that aren't options, and on values of the wrong shape, suggesting a fix. */
export function checkOptions(options: object, where: string, allowed = KNOWN): void {
  for (const key of Object.keys(options)) {
    if (allowed.includes(key)) continue
    const hint = SUGGEST[key] ? ` Did you mean "${SUGGEST[key]}"?` : ''
    throw new UsageError(`Unknown option "${key}" in ${where}.${hint}`)
  }
  const o = options as EvalOptions
  if (o.runs !== undefined && !(Number.isInteger(o.runs) && o.runs >= 1)) {
    throw new UsageError(`runs must be a whole number of at least 1 (got ${o.runs}) in ${where}`)
  }
  if (o.gate !== undefined) checkGate(o.gate, where)
  if (
    o.tags !== undefined &&
    (!Array.isArray(o.tags) || o.tags.some((t) => typeof t !== 'string'))
  ) {
    throw new UsageError(`tags must be a list of strings in ${where}`)
  }
  if (o.env !== undefined) checkEnv(o.env, where, UsageError)
  if (o.egress !== undefined) checkEgress(o.egress, where, UsageError)
  checkMaxConcurrent(o.judge?.maxConcurrent, `judge in ${where}`)
  if (o.environment !== undefined) {
    if (Array.isArray(o.environment)) {
      throw new UsageError(
        `environment takes one environment, not a list (${where}). To compare environments, use compare: [a, b]; the inherited environment is the control.`,
      )
    }
    if (!isEnvironment(o.environment)) {
      throw new UsageError(
        `environment in ${where} must come from defineEnvironment(…) (got ${describe(o.environment)})`,
      )
    }
  }
  if (o.sandbox !== undefined) {
    if (Array.isArray(o.sandbox)) {
      throw new UsageError(
        `sandbox takes one sandbox, not a list (${where}). Different toolchains need different checks, so write a separate eval per sandbox.`,
      )
    }
    if (!isSandbox(o.sandbox)) {
      throw new UsageError(`sandbox in ${where} must be like docker() (got ${describe(o.sandbox)})`)
    }
    checkMaxConcurrent(o.sandbox.maxConcurrent, `sandbox in ${where}`)
  }
  if (o.compare !== undefined) checkCompare(o.compare, where)
  if (o.pin !== undefined) {
    const bad = Array.isArray(o.pin) ? o.pin.filter((k) => !PINNABLE.includes(k)) : [o.pin]
    if (bad.length) {
      throw new UsageError(
        `pin accepts harness, runs and compare (got ${bad.map(String).join(', ')}) in ${where}`,
      )
    }
  }
}

function applyHarness(
  inherited: HarnessDescriptor[],
  value: EvalOptions['harness'],
  where: string,
): HarnessDescriptor[] {
  if (value === undefined) return inherited
  const next = typeof value === 'function' ? value(inherited) : value
  const list = Array.isArray(next) ? next : [next]
  if (list.length === 0) {
    throw new UsageError(
      `harness is an empty list in ${where}. Give at least one, e.g. harness: ${HARNESS_EXAMPLE}`,
    )
  }
  checkHarnesses(list, where)
  return list
}

/** Each harness is one, with a valid `maxConcurrent`. */
export function checkHarnesses(list: unknown[], where: string): void {
  for (const item of list) {
    if (!isHarness(item)) {
      throw new UsageError(
        `harness in ${where} must be like ${HARNESS_EXAMPLE} (got ${describe(item)})`,
      )
    }
    checkMaxConcurrent((item as HarnessDescriptor).maxConcurrent, `harness in ${where}`)
  }
}

function checkUnique(list: HarnessDescriptor[], where: string) {
  const seen = new Set<string>()
  for (const item of list) {
    const key = harnessId(item)
    if (!ID.test(key)) {
      throw new UsageError(
        `The harness id "${key}" in ${where} may only use letters, digits and . _ : @ + -`,
      )
    }
    if (seen.has(key)) {
      throw new UsageError(
        `Two harnesses in ${where} resolve to the id "${key}". Give one an id, e.g. cursor({ model: '…', id: '…' })`,
      )
    }
    seen.add(key)
  }
}

export type Level = { options: EvalOptions; where: string }

export type NormalizedCompare = {
  variants: Environment[]
  gate: CompareGate
  minLift?: number
  /** Harness ids; unset means every harness the eval runs. */
  harness?: string[]
  /** How many variants the eval asked for, before a profile's limit. */
  of: number
}

export type Resolved = {
  harness: HarnessDescriptor[]
  sandbox: SandboxDescriptor
  environment: Environment | undefined
  compare: NormalizedCompare | undefined
  runs: number
  /** Unset means `'all'`. */
  gate: GatePolicy | undefined
  env: EnvVars
  /** From the config and profile defaults, under the environment; from groups and the eval, over it. */
  egress: { inherited?: EgressPolicy; own?: EgressPolicy }
  judge: JudgeOptions
  timeout: Duration | undefined
  tags: string[]
  pin: PinnableKey[]
  /** Which level last set each option, e.g. `group("genkit")`; for the debug trace. */
  sources?: Partial<Record<keyof EvalOptions, string>>
}

function normalizeCompare(value: EvalOptions['compare']): NormalizedCompare | undefined {
  if (value === undefined || value === false) return undefined
  if (Array.isArray(value)) return { variants: value, gate: 'variants', of: value.length }
  return {
    variants: value.variants,
    gate: value.gate ?? 'variants',
    ...(value.minLift !== undefined ? { minLift: value.minLift } : {}),
    ...(value.harness
      ? { harness: value.harness.map((h) => (typeof h === 'string' ? h : harnessId(h))) }
      : {}),
    of: value.variants.length,
  }
}

function applyLevel(
  out: Resolved,
  options: EvalOptions,
  where: string,
  egress: 'inherited' | 'own' = 'own',
): void {
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) out.sources = { ...out.sources, [key]: where }
  }
  if (options.egress !== undefined) out.egress[egress] = options.egress
  out.harness = applyHarness(out.harness, options.harness, where)
  if (options.sandbox !== undefined) out.sandbox = options.sandbox
  if (options.environment !== undefined) out.environment = options.environment
  if (options.compare !== undefined) out.compare = normalizeCompare(options.compare)
  if (options.runs !== undefined) out.runs = options.runs
  if (options.gate !== undefined) out.gate = options.gate
  if (options.timeout !== undefined) out.timeout = options.timeout
  Object.assign(out.env, options.env)
  Object.assign(out.judge, options.judge)
  for (const tag of options.tags ?? []) if (!out.tags.includes(tag)) out.tags.push(tag)
  for (const key of options.pin ?? []) if (!out.pin.includes(key)) out.pin.push(key)
}

export type ResolvedEval = {
  resolved: Resolved
  /** What a profile changed, for the plan's notes column. */
  notes: string[]
  /** Set when a profile's limit leaves the eval nothing to run. */
  skip?: string
}

/**
 * Config, then the profile's defaults, then each enclosing group, then the eval; then the
 * profile's limit (narrowing only, except pinned keys); then `--runs`.
 */
export function cascade(
  base: Resolved,
  levels: Level[],
  where: string,
  options: { profile?: ResolvedProfile | null; runs?: number } = {},
): ResolvedEval {
  const out: Resolved = {
    ...base,
    env: { ...base.env },
    egress: { ...base.egress },
    judge: { ...base.judge },
    tags: [...base.tags],
    pin: [...base.pin],
  }
  const { profile } = options
  const notes: string[] = []
  if (profile) {
    const { defaults, judge } = profile
    applyLevel(
      out,
      { ...defaults, judge: { ...judge, ...defaults.judge } } as EvalOptions,
      `profiles.${profile.name}.defaults`,
      'inherited',
    )
  }
  for (const { options: own, where: at } of levels) applyLevel(out, own, at)
  checkUnique(out.harness, where)
  if (profile?.defaults.harness !== undefined && levels.some((l) => l.options.harness)) {
    notes.push('harness set by the eval')
  }
  const ids = out.harness.map(harnessId)
  const scope = out.compare?.harness
  const missing = scope?.filter((id) => !ids.includes(id)) ?? []
  if (missing.length) {
    throw new UsageError(
      `compare.harness lists ${missing.join(', ')}, which ${where} doesn't run (it runs ${ids.join(', ')}).`,
    )
  }
  for (const v of out.compare?.variants ?? []) {
    if (v.name === out.environment?.name) {
      throw new UsageError(
        `compare in ${where} lists ${v.name}, which is already the control (its environment). List only the alternatives.`,
      )
    }
  }
  const names = out.compare?.variants.map((v) => v.name) ?? []
  const dupe = names.find((n, i) => names.indexOf(n) !== i)
  if (dupe) throw new UsageError(`compare in ${where} lists two variants named ${dupe}`)

  let skip: string | undefined
  const limit = profile?.limit
  if (profile && limit) {
    const tag = `profile ${profile.name}`
    const pinned = (key: PinnableKey) => out.pin.includes(key)
    // --runs replaces the runs outright, so the profile's limit doesn't apply.
    if (
      limit.runs !== undefined &&
      options.runs === undefined &&
      !pinned('runs') &&
      out.runs > limit.runs
    ) {
      notes.push(`runs ${out.runs} → ${limit.runs} (${tag})`)
      out.runs = limit.runs
    }
    if (limit.harness && !pinned('harness')) {
      const kept = out.harness.filter((h) => limit.harness?.includes(harnessId(h)))
      if (kept.length === 0) {
        skip = `no harness left: ${tag} allows ${limit.harness.join(', ') || 'none'}`
      } else if (kept.length < out.harness.length) {
        notes.push(`harnesses ${out.harness.length} → ${kept.length} (${tag})`)
        out.harness = kept
      }
    }
    if (out.compare && limit.compare !== undefined && !pinned('compare')) {
      if (limit.compare === false) {
        notes.push(`compare off (${tag})`)
        out.compare = { ...out.compare, variants: [] }
      } else if (out.compare.variants.length > limit.compare.maxVariants) {
        notes.push(
          `variants ${out.compare.variants.length} → ${limit.compare.maxVariants} (${tag})`,
        )
        out.compare = {
          ...out.compare,
          variants: out.compare.variants.slice(0, limit.compare.maxVariants),
        }
      }
    }
    const pins = out.pin.filter((k) =>
      k === 'compare' ? limit.compare !== undefined && out.compare : limit[k] !== undefined,
    )
    if (pins.length) notes.push(`pinned: ${pins.join(', ')}`)
  }
  if (options.runs !== undefined) out.runs = options.runs
  return { resolved: out, notes, ...(skip ? { skip } : {}) }
}

export type PlannedAttempt = {
  cell: Cell
  harness: HarnessDescriptor
  sandbox: SandboxDescriptor
  environment: AppliedEnvironment
  egress: PlannedEgress
  gate: CellGate
  minLift?: number
  n: number
  label: string
}

/** Per harness: the control, then each variant it compares on; then run numbers. */
export function expand(resolved: Resolved): PlannedAttempt[] {
  const { compare } = resolved
  const sandbox = sandboxId(resolved.sandbox)
  const control = applied(resolved.environment)
  const policy = resolved.gate ?? 'all'
  const gateIf = (gated: boolean): CellGate => (gated ? policy : 'none')
  const attempts: PlannedAttempt[] = []
  for (const harness of resolved.harness) {
    const hid = harnessId(harness)
    const cells: Array<{ env: AppliedEnvironment; cell: Cell; gate: CellGate }> = [
      {
        env: control,
        cell: {
          key: cellKey(hid, control.name, sandbox),
          harness: hid,
          environment: control.name,
          sandbox,
          role: 'control',
        },
        gate: gateIf(!compare || compare.gate === 'all'),
      },
    ]
    if (compare && (!compare.harness || compare.harness.includes(hid))) {
      for (const v of compare.variants) {
        const env = layered(resolved.environment, v)
        cells.push({
          env,
          cell: {
            key: cellKey(hid, env.name, sandbox),
            harness: hid,
            environment: env.name,
            sandbox,
            role: 'variant',
            variant: v.name,
          },
          gate: gateIf(compare.gate !== 'none'),
        })
      }
    }
    for (const { env, cell, gate } of cells) {
      const axes = [
        resolved.harness.length > 1 ? hid : '',
        compare ? (cell.role === 'control' ? 'control' : env.name) : '',
      ].filter(Boolean)
      for (let n = 1; n <= resolved.runs; n++) {
        const label = [axes.join(' · '), resolved.runs > 1 ? `#${n}` : ''].filter(Boolean).join(' ')
        attempts.push({
          cell,
          harness,
          sandbox: resolved.sandbox,
          environment: env,
          egress: plannedEgress(resolved.egress, harness, resolved.env, env.layers),
          gate,
          ...(cell.role === 'variant' && compare?.minLift !== undefined
            ? { minLift: compare.minLift }
            : {}),
          n,
          label,
        })
      }
    }
  }
  return attempts
}

/** Warnings about what an eval's environments pull in, e.g. skills at a moving git ref. */
export function environmentWarnings(attempts: PlannedAttempt[]): string[] {
  const out = new Set<string>()
  for (const a of attempts) {
    for (const layer of a.environment.layers) {
      for (const s of layer.spec.skills ?? []) {
        if (s.source === 'git' && isMovingRef(s.ref)) {
          const ref = s.ref ? `moving ref "${s.ref}"` : 'no ref (the default branch)'
          out.add(
            `skill.git(${s.repo}) uses ${ref}: results aren't comparable over time. Pin a tag or SHA (the resolved commit is recorded either way).`,
          )
        }
        if (s.source === 'registry' && !s.version) {
          out.add(
            `skill.registry(${s.id}) has no version: results aren't comparable over time. Pin one (the resolved commit is recorded either way).`,
          )
        }
      }
    }
  }
  return [...out]
}

/** Secrets a Docker attempt would get as real values, because they have no `hosts`. */
export function unbrokered(env: EnvVars, attempts: PlannedAttempt[]): UnbrokeredSecret[] {
  const out = new Map<string, UnbrokeredSecret>()
  for (const a of attempts) {
    if (a.sandbox.kind !== 'docker') continue
    for (const s of unbrokeredSecrets(env, a.environment.layers)) out.set(s.label, s)
  }
  return [...out.values()]
}

/** `GEMINI_API_KEY → generativelanguage.googleapis.com` for each secret an attempt brokers. */
export const brokeredIn = (env: EnvVars, attempt: PlannedAttempt): string[] =>
  plannedSecrets(env, attempt.environment.layers).flatMap((s) =>
    s.hosts ? [`${s.label} → ${s.hosts.join(', ')}`] : [],
  )

const brokerHint = (s: UnbrokeredSecret) =>
  /^mcp\.[^.]+\.headers\./.test(s.label)
    ? 'give the MCP server an https:// URL (ES brokers its header secrets to its own host, over HTTPS only)'
    : `add the hosts it's sent to, e.g. secret.fromEnv('${s.from}', { hosts: ['api.example.com'] })`

export const unbrokeredWarning = (s: UnbrokeredSecret) =>
  s.checksOnly
    ? `${s.label} reaches the checks (t.exec, setup steps) as its real value; the agent never gets it. To give the checks only a placeholder, ${brokerHint(s)}.`
    : `${s.label} is in the sandbox as its real value. To give the agent only a placeholder, ${brokerHint(s)}.`

export const unbrokeredError = (s: UnbrokeredSecret, where: string) =>
  `${s.label} in ${where} isn't brokered, and secrets.unbrokered is 'error' in es.config.ts. To broker it, ${brokerHint(s)}.`

/** The plan row for an eval. */
export function evalPlan(r: ResolvedEval, attempts: PlannedAttempt[]): EvalPlan {
  const { resolved, notes, skip } = r
  return {
    harnesses: skip ? 0 : resolved.harness.length,
    variants: resolved.compare
      ? { run: resolved.compare.variants.length, of: resolved.compare.of }
      : null,
    runs: resolved.runs,
    ...(resolved.gate !== undefined ? { gate: resolved.gate } : {}),
    attempts: skip ? 0 : attempts.length,
    notes,
    ...(skip ? { skip } : {}),
    warnings: [
      ...environmentWarnings(attempts),
      ...unbrokered(r.resolved.env, attempts).map(unbrokeredWarning),
    ],
    brokered: [...new Set(attempts.flatMap((a) => brokeredIn(r.resolved.env, a)))],
    egress: [...new Set(attempts.map((a) => egressLabel(a.egress)).filter(Boolean))],
  }
}

/** `--tag a --tag !b`: every entry must hold. */
export function matchesTags(tags: string[], filters: string[]): boolean {
  return filters.every((f) => (f.startsWith('!') ? !tags.includes(f.slice(1)) : tags.includes(f)))
}
