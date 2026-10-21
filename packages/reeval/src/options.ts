// The options cascade shared by the config, profiles, groups and evals, and the cells it expands to.

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { mergeQuestion, showsNothing, withQuestionDefaults } from './compare/state.ts'
import { compareProblem, isEvaluationModel, questionOptionsProblem } from './contract/compare.ts'
import { sandboxProblem } from './contract/docker.ts'
import { harnessProblem } from './contract/harness.ts'
import { judgeProblem } from './contract/judge.ts'
import { gateProblem } from './contract/plain.ts'
import { closest } from './contract/shared.ts'
import { parseDuration } from './duration.ts'
import { egressLabel, plannedEgress } from './egress.ts'
import {
  type AppliedEnvironment,
  applied,
  checkEgress,
  checkEnv,
  EMPTY_BASELINE,
  emptyEnvironment,
  environmentDataProblem,
  isEnvironment,
  isMovingRef,
  plannedSecrets,
  sandboxOf,
  type UnbrokeredSecret,
  unbrokeredSecrets,
  workspaceLabel,
  workspaceOf,
} from './environment.ts'
import { UsageError } from './errors.ts'
import { HARNESS_EXAMPLE, isAgentKind } from './harness/agents.ts'
import { harnessEffort } from './harness/effort.ts'
import { opencodeModelError } from './harness.ts'
import { mergeJudge } from './judge/state-options.ts'
import { isObjectLike } from './object.ts'
import type {
  CaptureOptions,
  Cell,
  CellGate,
  CompareGate,
  CompareOptions,
  ConfigJudgeOptions,
  Duration,
  EgressPolicy,
  Environment,
  EnvVars,
  EvalOptions,
  EvalPlan,
  GatePolicy,
  HarnessDescriptor,
  HarnessEdit,
  InstallStep,
  JudgeOptions,
  PairFactor,
  PinnableKey,
  PlannedEgress,
  PlannedQuestion,
  QuestionOptions,
  ResolvedProfile,
  SandboxDescriptor,
  SandboxWarning,
} from './types.ts'

/** Every eval/group option key `checkOptions` accepts. The feature matrix holds each to an inventory entry. */
export const EVAL_OPTION_KEYS = [
  'harness',
  'sandbox',
  'environment',
  'compare',
  'runs',
  'gate',
  'env',
  'egress',
  'judge',
  'capture',
  'question',
  'timeout',
  'tags',
  'pin',
] as const
export type EvalOptionKey = (typeof EVAL_OPTION_KEYS)[number]

const KNOWN: EvalOptionKey[] = [...EVAL_OPTION_KEYS]
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
  const problem = gateProblem(value, where)
  if (problem) throw new UsageError(problem)
}
const PINNABLE: PinnableKey[] = ['harness', 'runs', 'compare']

const ID = /^[A-Za-z0-9._:@+\-=[\]]+$/

const sanitize = (text: string) =>
  (text.split('/').at(-1) ?? text).replace(/[^A-Za-z0-9._:@-]+/g, '-')

export function harnessId(h: HarnessDescriptor): string {
  if (h.id) return h.id
  const effort = harnessEffort(h)
  const suffix = effort ? `[effort=${sanitize(effort)}]` : ''
  if (h.kind === 'fake') return `fake${suffix}`
  const base = h.model ? `${h.kind}:${sanitize(h.model)}` : h.kind
  return `${base}${suffix}`
}

function installId(install: readonly InstallStep[] | undefined): string {
  if (!install?.length) return ''
  const key = JSON.stringify(
    install.map((step) =>
      typeof step === 'string' ? step : { run: step.run, timeout: step.timeout },
    ),
  )
  return `+${createHash('sha256').update(key).digest('hex').slice(0, 8)}`
}

/** The provider a sandbox runs on: its kind, or `podman` for a Docker sandbox on Podman. */
export const sandboxProvider = (s: SandboxDescriptor): 'docker' | 'podman' | 'fake' =>
  s.kind === 'docker' && s.engine === 'podman' ? 'podman' : s.kind

export function sandboxId(s: SandboxDescriptor): string {
  if (s.id) return s.id
  if (s.kind === 'fake') return 'fake'
  const install = s.kind === 'docker' ? installId(s.install) : ''
  const engine = s.engine ?? 'docker'
  if (s.dockerfile) {
    const [file = '', dir = ''] = s.dockerfile.split(/[\\/]/).reverse()
    return `${engine}:${sanitize(file === 'Dockerfile' ? dir || file : file)}${install}`
  }
  const image = s.image ?? s.from
  return image ? `${engine}:${sanitize(image)}${install}` : `${engine}${install}`
}

export const cellKey = (harness: string, environment: string, sandbox: string) =>
  `${harness}/${environment}/${sandbox}`

const isHarness = (v: unknown): v is HarnessDescriptor =>
  isObjectLike(v) && (v.kind === 'fake' || isAgentKind(v.kind))

function checkMaxConcurrent(value: unknown, where: string): void {
  if (value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 1)) {
    return
  }
  throw new UsageError(
    `${where} must be a whole number of at least 1 (got ${JSON.stringify(value)})`,
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

/** `compare: false` and `environment` beside `compare.baseline` are never legal options. */
export function refuseIllegalCompare(
  options: { environment?: unknown; compare?: unknown },
  where: string,
): void {
  if (options.compare === false) {
    throw new UsageError(
      `compare: false can't be set in ${where}. A profile turns compare off with limit.compare: false, which runs the baseline and strips the variants. On a group or eval, omit compare or pass compare: { baseline, variants }.`,
    )
  }
  const baseline =
    options.compare !== null && typeof options.compare === 'object' && 'baseline' in options.compare
      ? options.compare.baseline
      : undefined
  if (options.environment !== undefined && baseline !== undefined) {
    throw new UsageError(
      `environment and compare.baseline can't both be set in ${where}. compare: { baseline, variants } names every arm, so drop environment, or drop baseline to make environment the control.`,
    )
  }
}

/** Throws on keys that aren't options, and on values of the wrong shape, suggesting a fix. */
export function checkOptions(options: object, where: string, allowed = KNOWN): void {
  for (const key of Object.keys(options)) {
    if (allowed.includes(key)) continue
    const near = SUGGEST[key] ?? closest(key, allowed)
    const hint =
      key === 'pool'
        ? ' pool is an option of evaluate.each, beside the cases: evaluate.each(cases, { pool: false }).'
        : near
          ? ` Did you mean "${near}"?`
          : ''
    throw new UsageError(`Unknown option "${key}" in ${where}.${hint}`)
  }
  const o = options as EvalOptions
  if (o.runs !== undefined && !(Number.isInteger(o.runs) && o.runs >= 1)) {
    throw new UsageError(
      `runs in ${where} must be a whole number of at least 1 (got ${JSON.stringify(o.runs)})`,
    )
  }
  if (o.gate !== undefined) checkGate(o.gate, where)
  if (
    o.tags !== undefined &&
    (!Array.isArray(o.tags) || o.tags.some((t) => typeof t !== 'string'))
  ) {
    throw new UsageError(
      `tags in ${where} must be a list of strings, e.g. tags: ['smoke'] (got ${JSON.stringify(o.tags)})`,
    )
  }
  if (o.env !== undefined) checkEnv(o.env, where, UsageError)
  if (o.egress !== undefined) checkEgress(o.egress, where, UsageError)
  const judgeIssue = o.judge !== undefined && judgeProblem(o.judge, { at: 'options', where })
  if (judgeIssue) throw new UsageError(judgeIssue)
  if (o.sandbox !== undefined) {
    const kind = (o.sandbox as { kind?: string }).kind
    if (kind !== 'docker' && kind !== 'fake') {
      throw new UsageError(
        `sandbox in ${where} must come from docker(), podman() or fakeSandbox() (got ${describe(o.sandbox)})`,
      )
    }
    const max = o.sandbox.maxConcurrent
    if (max !== undefined && !(Number.isInteger(max) && max >= 1)) {
      throw new UsageError(
        `sandbox.maxConcurrent in ${where} must be a whole number of at least 1 (got ${String(max)})`,
      )
    }
    const problem = sandboxProblem(o.sandbox)
    if (problem) throw new UsageError(`sandbox in ${where}: ${problem}`)
  }
  if (o.environment !== undefined) {
    if (Array.isArray(o.environment)) {
      throw new UsageError(
        `environment takes one environment, not a list (${where}). To compare environments, use compare: { baseline, variants: [a, b] }. baseline is the control; variants are not layered on it.`,
      )
    }
    if (!isEnvironment(o.environment)) {
      throw new UsageError(
        `environment in ${where} must come from defineEnvironment(…) (got ${describe(o.environment)})`,
      )
    }
    const problem = environmentDataProblem(o.environment, 'environment', where)
    if (problem) throw new UsageError(problem)
  }
  const raw = options as { environment?: unknown; compare?: unknown }
  refuseIllegalCompare(raw, where)
  if (o.compare !== undefined) {
    const problem = compareProblem(o.compare, where, z.custom<Environment>(isEnvironment))
    if (problem) throw new UsageError(problem)
    const { baseline, variants } = o.compare
    for (const [label, env] of [
      ['compare.baseline', baseline],
      ...variants.map((v, i) => [`compare.variants[${i}]`, v] as const),
    ] as const) {
      const bad = env && environmentDataProblem(env, label, where)
      if (bad) throw new UsageError(bad)
    }
  }
  if (o.pin !== undefined) {
    const bad = Array.isArray(o.pin) ? o.pin.filter((k) => !PINNABLE.includes(k)) : [o.pin]
    if (bad.length) {
      throw new UsageError(
        `pin in ${where} lists harness, runs and/or compare (got ${bad.map((k) => JSON.stringify(k)).join(', ')})`,
      )
    }
  }
  if (o.capture !== undefined) checkCapture(o.capture, where)
  const questionIssue = o.question !== undefined && questionOptionsProblem(o.question, where)
  if (questionIssue) throw new UsageError(questionIssue)
}

const CAPTURE_KEYS = ['viewport', 'timeout', 'browser', 'model']
const CAPTURE_SHAPE = '{ viewport?, timeout?, browser?, model? }'
const CAPTURE_CALL_ONLY = new Set(['instructions', 'wait', 'name', 'path'])

/** Throws unless `capture` is a shallow-merge object with a viewport, timeout, browser and/or model. */
export function checkCapture(value: unknown, where: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UsageError(`capture in ${where} is ${CAPTURE_SHAPE} (got ${JSON.stringify(value)})`)
  }
  const o = value as CaptureOptions & Record<string, unknown>
  if (o.instructions !== undefined) {
    throw new UsageError(
      `capture.instructions in ${where} can't be set: instructions go on the call, c.capture(port, { instructions }).`,
    )
  }
  const unknown = Object.keys(o).filter((k) => !CAPTURE_KEYS.includes(k))
  if (unknown.length) {
    const key = unknown[0] ?? ''
    if (key === 'use' || key === 'fake') {
      throw new UsageError(
        `Unknown capture key "${key}" in ${where}. Set capture.model; tests pass fakeInstructions from reeval/testing as instructions.`,
      )
    }
    if (CAPTURE_CALL_ONLY.has(key)) {
      throw new UsageError(
        `capture.${key} in ${where} can't be set: ${key} goes on the call, c.capture(port, { ${key} }). Use viewport, timeout, browser, model.`,
      )
    }
    throw new UsageError(
      `Unknown capture key "${key}" in ${where}. Use viewport, timeout, browser, model.`,
    )
  }
  if (o.viewport !== undefined) checkViewport(o.viewport, where)
  if (o.timeout !== undefined) parseDuration(o.timeout)
  if (o.browser !== undefined && typeof o.browser !== 'boolean') {
    throw new UsageError(
      `capture.browser in ${where} is true or false (got ${JSON.stringify(o.browser)})`,
    )
  }
  if (o.model !== undefined) checkCaptureModel(o.model, where)
}

function checkViewport(value: unknown, where: string): void {
  if (value === 'full-page') return
  if (!isObjectLike(value) || Array.isArray(value)) {
    throw new UsageError(
      `capture.viewport in ${where} is { width, height } or 'full-page' (got ${JSON.stringify(value)})`,
    )
  }
  const keys = Object.keys(value)
  if (keys.includes('fullPage')) {
    throw new UsageError(
      `capture.viewport in ${where} is { width, height } or 'full-page', not { height, fullPage }. Use viewport: 'full-page' for a tall shot.`,
    )
  }
  const isSize = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n > 0
  if (
    keys.some((k) => k !== 'width' && k !== 'height') ||
    !isSize(value.width) ||
    !isSize(value.height)
  ) {
    throw new UsageError(
      `capture.viewport in ${where} is { width, height } or 'full-page' (got ${JSON.stringify(value)})`,
    )
  }
}

function checkCaptureModel(value: unknown, where: string): void {
  if (typeof value !== 'string' || !value.includes('/')) {
    throw new UsageError(
      `capture.model in ${where} is a 'provider/model' string, e.g. 'google/gemini-3.8-flash' (got ${JSON.stringify(value)})`,
    )
  }
  if (isEvaluationModel(value)) {
    throw new UsageError(
      `capture.model "${value}" in ${where} is an evaluation model: it scores yes/no questions and can't drive a capture. Use a language model that accepts images, e.g. 'google/gemini-3.8-flash'.`,
    )
  }
}

function applyHarness(
  inherited: HarnessDescriptor[],
  value: EvalOptions['harness'],
  where: string,
): HarnessDescriptor[] {
  if (value === undefined) return inherited
  const next =
    typeof value === 'function'
      ? value(inherited)
      : isHarnessEdit(value)
        ? editHarness(inherited, value, where)
        : value
  const list = Array.isArray(next) ? next : [next]
  if (list.length === 0) {
    throw new UsageError(
      `harness is an empty list in ${where}. Give at least one, e.g. harness: ${HARNESS_EXAMPLE}`,
    )
  }
  checkHarnesses(list, where)
  return list
}

const isHarnessEdit = (v: unknown): v is HarnessEdit =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  !('kind' in v) &&
  ('add' in v || 'only' in v)

/** `{ add }` appends to the inherited harnesses; `{ only }` keeps those with these ids. */
function editHarness(
  inherited: HarnessDescriptor[],
  edit: HarnessEdit,
  where: string,
): HarnessDescriptor[] {
  if ('add' in edit && 'only' in edit) {
    throw new UsageError(
      `harness in ${where} takes { add } or { only }, not both. Use add to append to the inherited harnesses, only to keep some of them.`,
    )
  }
  if ('add' in edit) return [...inherited, ...(Array.isArray(edit.add) ? edit.add : [edit.add])]
  const ids = Array.isArray(edit.only) ? edit.only : [edit.only]
  const have = inherited.map(harnessId)
  const missing = ids.filter((id) => typeof id !== 'string' || !have.includes(id))
  if (missing.length) {
    throw new UsageError(
      `harness { only: ${missing.map((id) => JSON.stringify(id)).join(', ')} } in ${where} names no inherited harness (inherited: ${have.join(', ')})`,
    )
  }
  return inherited.filter((h) => ids.includes(harnessId(h)))
}

/** Each harness is one, with a valid `maxConcurrent`. */
export function checkHarnesses(list: unknown[], where: string): void {
  for (const item of list) {
    if (!isHarness(item)) {
      throw new UsageError(
        `harness in ${where} must be like ${HARNESS_EXAMPLE} (got ${describe(item)})`,
      )
    }
    if (item.kind === 'opencode') {
      const why = opencodeModelError(item.model)
      if (why) throw new UsageError(`opencode() in ${where}: ${why}`)
    }
    checkMaxConcurrent(item.maxConcurrent, `harness.maxConcurrent in ${where}`)
    const { startTimeout } = item
    if (startTimeout !== undefined) {
      try {
        parseDuration(startTimeout)
      } catch (error) {
        throw new UsageError(`harness.startTimeout in ${where}: ${(error as Error).message}`)
      }
    }
    const problem = harnessProblem(item)
    if (problem) throw new UsageError(`harness in ${where}: ${problem}`)
  }
}

function checkUnique(list: HarnessDescriptor[], where: string) {
  const seen = new Set<string>()
  for (const item of list) {
    const key = harnessId(item)
    if (!ID.test(key)) {
      throw new UsageError(
        `The harness id "${key}" in ${where} may only use letters, digits and . _ : @ + - [ ] =`,
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
  /** The control, once `cascade` resolves an omitted `baseline`. */
  baseline: Environment
  /** Set when `baseline` was omitted: where the control came from. */
  from?: 'environment' | 'empty'
  variants: Environment[]
  gate: CompareGate
  minLift?: number
  /** Harness ids; unset means every harness the eval runs. */
  harness?: string[]
  /** How many variants the eval asked for, before a profile's limit. */
  of: number
  /** Asked after the run; empty without any, or once a limit leaves one arm. */
  questions: PlannedQuestion[]
}

/** A question's own `across`, else the one `compare.across` names when it names exactly one. */
const plannedAcross = (
  own: PairFactor | undefined,
  compare: PairFactor | PairFactor[] | undefined,
): PairFactor | undefined => {
  if (own) return own
  const list = compare === undefined ? undefined : Array.isArray(compare) ? compare : [compare]
  return list?.length === 1 ? list[0] : undefined
}

const plannedQuestions = (
  value: CompareOptions['questions'],
  compareAcross?: PairFactor | PairFactor[],
): PlannedQuestion[] =>
  (value ?? []).map((q) => {
    if (typeof q === 'string') {
      const across = plannedAcross(undefined, compareAcross)
      return across ? { question: q, across } : { question: q }
    }
    const across = plannedAcross(q.across, compareAcross)
    return {
      question: q.question,
      ...(q.model !== undefined ? { model: q.model } : {}),
      ...(across ? { across } : {}),
      ...(q.state ? { state: q.state } : {}),
      ...(q.artifacts !== undefined ? { artifacts: q.artifacts } : {}),
    }
  })

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
  capture: CaptureOptions
  /** Defaults for every compare question; applied to the compare's own once the cascade ends. */
  question: QuestionOptions
  timeout: Duration | undefined
  tags: string[]
  pin: PinnableKey[]
  /** Which level last set each option, e.g. `group("genkit")`; for the debug trace. */
  sources?: Partial<Record<keyof EvalOptions, string>>
}

function normalizeCompare(value: EvalOptions['compare']): NormalizedCompare | undefined {
  if (value === undefined) return undefined
  return {
    // An omitted baseline stays empty until `cascade` knows the eval's environment.
    ...(value.baseline
      ? { baseline: value.baseline }
      : { baseline: emptyEnvironment(EMPTY_BASELINE), from: 'empty' as const }),
    variants: value.variants,
    gate: value.gate ?? 'variants',
    ...(value.minLift !== undefined ? { minLift: value.minLift } : {}),
    ...(value.harness
      ? { harness: value.harness.map((h) => (typeof h === 'string' ? h : harnessId(h))) }
      : {}),
    of: value.variants.length,
    questions: plannedQuestions(value.questions, value.across),
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
  out.judge = mergeJudge(out.judge, options.judge)
  if (options.capture !== undefined) {
    const { viewport, ...rest } = options.capture
    out.capture = { ...out.capture, ...rest }
    if (viewport !== undefined) out.capture.viewport = viewport
  }
  out.question = mergeQuestion(out.question, options.question)
  for (const tag of options.tags ?? []) if (!out.tags.includes(tag)) out.tags.push(tag)
  for (const key of options.pin ?? []) if (!out.pin.includes(key)) out.pin.push(key)
}

/** What a profile sets over the config's judge: its `judge`, then its `defaults.judge`. */
export const profileJudge = (profile: ResolvedProfile): ConfigJudgeOptions =>
  mergeJudge(profile.judge, profile.defaults.judge)

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
    capture: { ...base.capture },
    question: { ...base.question },
    tags: [...base.tags],
    pin: [...base.pin],
  }
  const { profile } = options
  const notes: string[] = []
  if (profile) {
    applyLevel(
      out,
      { ...profile.defaults, judge: profileJudge(profile) } as EvalOptions,
      `profiles.${profile.name}.defaults`,
      'inherited',
    )
  }
  for (const { options: own, where: at } of levels) applyLevel(out, own, at)
  if (out.compare?.from && out.environment) {
    out.compare = { ...out.compare, baseline: out.environment, from: 'environment' }
  }
  if (out.compare?.questions.length) {
    const questions = out.compare.questions.map((q) => withQuestionDefaults(q, out.question))
    const blank = questions.find(showsNothing)
    if (blank) {
      throw new UsageError(
        `compare.questions "${blank.question}" in ${where} shows the model nothing: every state key is off and it sends no artifacts. Turn on a state key, such as state: { diff: true }, or send artifacts.`,
      )
    }
    out.compare = { ...out.compare, questions }
  }
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
    if (v.name === out.compare?.baseline.name) {
      throw new UsageError(
        out.compare.from === 'empty'
          ? `compare in ${where} lists a variant named ${v.name}, the name of the empty control a compare without a baseline or environment runs. Rename the variant, or set compare.baseline.`
          : out.compare.from === 'environment'
            ? `compare in ${where} lists ${v.name}, which is the control: compare has no baseline, so the eval's environment is. List only the other environments.`
            : `compare in ${where} lists ${v.name}, which is the baseline. List only the other environments.`,
      )
    }
  }
  const names = out.compare?.variants.map((v) => v.name) ?? []
  const dupe = names.find((n, i) => names.indexOf(n) !== i)
  if (dupe)
    throw new UsageError(
      `compare in ${where} lists two variants named ${dupe}. Give each variant its own name.`,
    )

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
      // A question compares arms, so with the baseline alone there is nothing to ask it of.
      if (out.compare.variants.length === 0 && out.compare.questions.length) {
        notes.push(`questions off (${tag})`)
        out.compare = { ...out.compare, questions: [] }
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

/**
 * The sandbox an attempt runs in: the resolved environment's (including an `.extend()`
 * parent's), else the first variant's when this is an omitted-baseline empty control, else
 * the cascaded option (`defineConfig` / profile defaults / group / eval), else implicit Docker.
 * A named environment is a total override: the config environment's sandbox is not inherited.
 */
export const attemptSandbox = (resolved: Resolved, env: AppliedEnvironment): SandboxDescriptor => {
  const own = env.layers.findLast((l) => l.spec.sandbox)?.spec.sandbox
  if (own) return own
  // An omitted-baseline empty control has no layers. Use the first variant's sandbox so the
  // compare is the same machine without the variant's files, not implicit Docker vs Node 24.
  const variant =
    resolved.compare?.from === 'empty' && env.name === EMPTY_BASELINE
      ? resolved.compare.variants[0]
      : undefined
  return sandboxOf(variant?.layers ?? [], resolved.sandbox)
}

/**
 * Which level set this attempt's sandbox: the cascade source of the environment that named one
 * (an `.extend()` child still names that environment), else the first variant when this is an
 * omitted-baseline empty control, else the cascaded `sandbox` option, else the config (implicit
 * Docker).
 */
export function sandboxSetBy(
  planned: Pick<PlannedAttempt, 'environment' | 'cell'>,
  resolved: Resolved,
  configFile: string,
): string {
  if (!planned.environment.layers.some((l) => l.spec.sandbox)) {
    if (
      resolved.compare?.from === 'empty' &&
      planned.cell.role === 'control' &&
      resolved.compare.variants[0]?.layers.some((l) => l.spec.sandbox)
    ) {
      return resolved.sources?.compare ?? configFile
    }
    return resolved.sources?.sandbox ?? configFile
  }
  if (resolved.compare) {
    if (planned.cell.role === 'control') {
      if (resolved.compare.from === 'environment') {
        return resolved.sources?.environment ?? configFile
      }
      if (resolved.compare.from === 'empty') return configFile
      return resolved.sources?.compare ?? configFile
    }
    return resolved.sources?.compare ?? configFile
  }
  return resolved.sources?.environment ?? configFile
}

/** Per harness: the control, then each variant it compares on; then run numbers. */
export function expand(resolved: Resolved): PlannedAttempt[] {
  const { compare } = resolved
  // A compare's control is its baseline, which `cascade` resolved when it was omitted. An
  // environment from another level is not applied beside it.
  const control = applied(compare ? compare.baseline : resolved.environment)
  const policy = resolved.gate ?? 'all'
  const gateIf = (gated: boolean): CellGate => (gated ? policy : 'none')
  const attempts: PlannedAttempt[] = []
  for (const harness of resolved.harness) {
    const hid = harnessId(harness)
    const cells: Array<{
      env: AppliedEnvironment
      sandbox: SandboxDescriptor
      cell: Cell
      gate: CellGate
    }> = [
      (() => {
        const sandbox = attemptSandbox(resolved, control)
        const sid = sandboxId(sandbox)
        return {
          env: control,
          sandbox,
          cell: {
            key: cellKey(hid, control.name, sid),
            harness: hid,
            environment: control.name,
            sandbox: sid,
            role: 'control' as const,
          },
          // A compare a profile's limit left without variants has nothing to compare the
          // control against, so it gates like an eval without compare.
          gate: gateIf(!compare || compare.variants.length === 0 || compare.gate === 'all'),
        }
      })(),
    ]
    if (compare && (!compare.harness || compare.harness.includes(hid))) {
      for (const v of compare.variants) {
        const env = applied(v)
        const sandbox = attemptSandbox(resolved, env)
        const sid = sandboxId(sandbox)
        cells.push({
          env,
          sandbox,
          cell: {
            key: cellKey(hid, env.name, sid),
            harness: hid,
            environment: env.name,
            sandbox: sid,
            role: 'variant',
            variant: v.name,
          },
          gate: gateIf(compare.gate !== 'none'),
        })
      }
    }
    for (const { env, sandbox, cell, gate } of cells) {
      const axes = [
        resolved.harness.length > 1 ? hid : '',
        compare ? (cell.role === 'control' ? 'control' : env.name) : '',
      ].filter(Boolean)
      for (let n = 1; n <= resolved.runs; n++) {
        const label = [axes.join(' · '), resolved.runs > 1 ? `#${n}` : ''].filter(Boolean).join(' ')
        attempts.push({
          cell,
          harness,
          sandbox,
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
    const workspace = workspaceOf(a.environment.layers)
    if (workspace && isMovingRef(workspace.ref)) {
      const ref = workspace.ref ? `moving ref "${workspace.ref}"` : 'no ref (the default branch)'
      out.add(
        `workspace git(${workspace.repo}) uses ${ref}: results aren't comparable over time. Pin a tag or SHA (the resolved commit is recorded either way).`,
      )
    }
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

/** An optional secret whose host variable isn't set never reaches the sandbox, so it gets no warning. */
const reachesSandbox = (s: UnbrokeredSecret) => !s.optional || Boolean(process.env[s.from])

/** `GEMINI_API_KEY → generativelanguage.googleapis.com` for each secret with `hosts`. */
const withHosts = (env: EnvVars, attempt: PlannedAttempt): string[] => [
  ...new Set(
    plannedSecrets(env, attempt.environment.layers).flatMap((s) =>
      s.hosts ? [`${s.label} → ${s.hosts.join(', ')}`] : [],
    ),
  ),
]

/** The secrets an attempt brokers: only Docker's egress gateway swaps a placeholder for its value. */
export const brokeredIn = (env: EnvVars, attempt: PlannedAttempt): string[] =>
  attempt.sandbox.kind === 'docker' ? withHosts(env, attempt) : []

/** The plan's note for secrets with `hosts` on the fake sandbox, which only ever has their placeholder. */
function unbrokeredOnFake(env: EnvVars, attempts: PlannedAttempt[]): string[] {
  const names = [
    ...new Set(attempts.flatMap((a) => (a.sandbox.kind === 'fake' ? withHosts(env, a) : []))),
  ]
  return names.length ? [`not brokered (fake sandbox, placeholder only): ${names.join('; ')}`] : []
}

/** The host variables an attempt's secrets read, brokered or not. */
export const secretVarsIn = (env: EnvVars, attempt: PlannedAttempt): string[] => [
  ...new Set(plannedSecrets(env, attempt.environment.layers).map((s) => s.from)),
]

const brokerHint = (s: UnbrokeredSecret) =>
  /^mcp\.[^.]+\.headers\./.test(s.label)
    ? 'give the MCP server an https:// URL (reeval brokers its header secrets to its own host, over HTTPS only)'
    : `add the hosts it's sent to, e.g. secret.fromEnv('${s.from}', { hosts: ['api.example.com'] })`

export const unbrokeredWarning = (s: UnbrokeredSecret) =>
  s.checksOnly
    ? `${s.label} reaches the checks (c.exec, setup steps) as its real value; the agent never gets it. To give the checks only a placeholder, ${brokerHint(s)}.`
    : `${s.label} is in the sandbox as its real value. To give the agent only a placeholder, ${brokerHint(s)}.`

export const unbrokeredError = (s: UnbrokeredSecret, where: string, configFile: string) =>
  `${s.label} in ${where} isn't brokered, and secrets.unbrokered is 'error' in ${configFile}. To broker it, ${brokerHint(s)}.`

export const levelOf = (where: string): SandboxWarning['level'] =>
  where.startsWith('evaluate(')
    ? 'eval'
    : where.startsWith('group(')
      ? 'group'
      : where.startsWith('profiles.')
        ? 'profile'
        : 'config'

/**
 * A warning per privilege an attempt's Docker sandbox adds, naming the level that set the
 * environment which owns that sandbox: the config when no profile, group or eval did.
 */
export function sandboxWarnings(
  attempts: PlannedAttempt[],
  resolved: Resolved,
  origin: { configFile: string; file: string | null },
): SandboxWarning[] {
  const out: SandboxWarning[] = []
  const seen = new Set<string>()
  for (const a of attempts) {
    if (a.sandbox.kind !== 'docker') continue
    const where = sandboxSetBy(a, resolved, origin.configFile)
    const level = levelOf(where)
    const file = level === 'eval' || level === 'group' ? origin.file : null
    if (a.sandbox.root) {
      const message = `running as root in the sandbox: ${where} (docker({ root: true }))`
      const key = `${file}\0${message}`
      if (!seen.has(key)) {
        seen.add(key)
        out.push({ kind: 'root', level, where, file, message })
      }
    }
    if (a.sandbox.capabilities?.length) {
      const list = a.sandbox.capabilities.map((c) => `'${c}'`).join(', ')
      const message = `extra capabilities in the sandbox: ${where} (docker({ capabilities: [${list}] }))`
      const key = `${file}\0${message}`
      if (!seen.has(key)) {
        seen.add(key)
        out.push({
          kind: 'capabilities',
          level,
          where,
          file,
          capabilities: [...a.sandbox.capabilities],
          message,
        })
      }
    }
  }
  return out
}

/** The plan row for an eval. */
export function evalPlan(
  r: ResolvedEval,
  attempts: PlannedAttempt[],
  origin: { configFile: string; file: string | null },
): EvalPlan {
  const { resolved, skip } = r
  const capture = captureNote(resolved.capture)
  const notes = [
    ...r.notes,
    ...(capture ? [capture] : []),
    ...unbrokeredOnFake(resolved.env, attempts),
  ]
  return {
    harnesses: skip ? 0 : resolved.harness.length,
    variants: resolved.compare
      ? { run: resolved.compare.variants.length, of: resolved.compare.of }
      : null,
    ...(resolved.compare
      ? {
          compare: {
            baseline: resolved.compare.baseline.name,
            ...(resolved.compare.from ? { from: resolved.compare.from } : {}),
          },
        }
      : {}),
    ...(!skip && resolved.compare?.questions.length
      ? { questions: resolved.compare.questions }
      : {}),
    runs: resolved.runs,
    ...(resolved.gate !== undefined ? { gate: resolved.gate } : {}),
    attempts: skip ? 0 : attempts.length,
    notes,
    ...(skip ? { skip } : {}),
    warnings: [
      ...environmentWarnings(attempts),
      ...(skip ? [] : questionWarnings(resolved)),
      ...unbrokered(r.resolved.env, attempts).filter(reachesSandbox).map(unbrokeredWarning),
    ],
    sandboxWarnings: skip ? [] : sandboxWarnings(attempts, resolved, origin),
    brokered: [...new Set(attempts.flatMap((a) => brokeredIn(r.resolved.env, a)))],
    egress: [...new Set(attempts.map((a) => egressLabel(a.egress)).filter(Boolean))],
    workspaces: [
      ...new Set(
        attempts.flatMap((a) => {
          const w = workspaceOf(a.environment.layers)
          return w ? [workspaceLabel(w)] : []
        }),
      ),
    ],
    ...(capture ? { capture: resolved.capture } : {}),
  }
}

/** A question that shows each side's transcript, asked of two harnesses: tool names unblind it. */
function questionWarnings(resolved: Resolved): string[] {
  const { compare } = resolved
  if (!compare || resolved.harness.length < 2) return []
  return compare.questions
    .filter((q) => q.across !== 'environment' && q.state?.transcript)
    .map(
      (q) =>
        `compare question "${q.question}" shows state.transcript, which names each harness's tools, so its harness pairs aren't blind. Ask it with across: 'environment', or leave the transcript out.`,
    )
}

function captureNote(c: CaptureOptions): string | undefined {
  const parts: string[] = []
  if (c.viewport === 'full-page') parts.push('full-page')
  else if (c.viewport) parts.push(`${c.viewport.width}×${c.viewport.height}`)
  if (c.timeout !== undefined) {
    parts.push(typeof c.timeout === 'number' ? `${c.timeout}ms` : c.timeout)
  }
  if (c.browser === false) parts.push('browser false')
  if (c.model) parts.push(`model ${c.model}`)
  return parts.length ? `capture: ${parts.join(' · ')}` : undefined
}

/** `--tag a --tag !b`: every entry must hold. */
export function matchesTags(tags: string[], filters: string[]): boolean {
  return filters.every((f) => (f.startsWith('!') ? !tags.includes(f.slice(1)) : tags.includes(f)))
}
