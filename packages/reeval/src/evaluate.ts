import { dirname } from 'node:path'
import { runAttempt } from './attempt/index.ts'
import { bestOfCell } from './best-of.ts'
import { caseEvalName, caseKeys } from './cases.ts'
import { declarationProblem } from './contract/declaration.ts'
import type {
  DeclarationTree,
  DeclaredFamily,
  DeclaredGroup,
  DeclaredMode,
  DeclaredNode,
  DeclaredSource,
} from './declaration.ts'
import {
  collectingFile,
  declareHarnesses,
  getRunContext,
  registerGroup,
  registerTest,
} from './engine/runtime.ts'
import { inCI } from './env.ts'
import {
  callerDir,
  environmentFrom,
  environmentPaths,
  type MissingDockerfile,
  sandboxPaths,
} from './environment.ts'
import { UsageError } from './errors.ts'
import { bodyHash, caseHash } from './eval-source.ts'
import { evalId } from './ids.ts'
import { isObjectLike } from './object.ts'
import { checkOptions, matchesTags, refuseIllegalCompare } from './options.ts'
import { type PlannedEval, planEval } from './plan-eval.ts'
import type {
  CaseFn,
  CaseOptions,
  Environment,
  EnvironmentData,
  EnvironmentsData,
  EvalFn,
  EvalOptions,
  EvalOptionsData,
  GroupOptions,
  SurveyOptions,
} from './types.ts'
import type { CaseWhere } from './where.ts'

type Declaring = { name: string; options: GroupOptions; node: DeclaredGroup }

// The groups enclosing the code being collected. The collector runs a nested group's callback
// after its parent's callback has returned, so each group captures its parents when declared.
let groupStack: Declaring[] = []

/** Each eval file's declarations as `evaluate` and `group` were called, and each eval's body by id. */
const trees = new Map<string, DeclarationTree>()
const bodies = new Map<string, EvalFn>()

/** What the file being collected has declared so far. */
export function declaredTree(file: string): DeclarationTree | undefined {
  return trees.get(file)
}

/** An eval's body, by the id its declaration names. */
export const declaredBody = (id: string): EvalFn | undefined => bodies.get(id)

/** Options as the tree holds them; from TypeScript they may still hold function forms. */
const data = (options: EvalOptions) => options as EvalOptionsData

function declare(node: DeclaredNode): void {
  const parent = groupStack.at(-1)?.node
  if (parent) return void parent.children.push(node)
  const file = collectingFile() ?? ''
  const tree = trees.get(file) ?? { children: [] }
  trees.set(file, tree)
  tree.children.push(node)
}

const missingIn =
  (where: string): MissingDockerfile =>
  (field, full) => {
    throw new UsageError(
      `${field} in ${where}: ${full} doesn't exist. Paths are relative to the file that declares it.`,
    )
  }

/**
 * The options with a `sandbox` written as data given absolute host paths against `base`, the
 * eval file, as `docker()` and `fakeSandbox()` resolve theirs against the file that calls them.
 */
function withPaths<T extends GroupOptions>(
  options: T,
  where: string,
  base = callerDir() ?? process.cwd(),
): T {
  if (typeof options !== 'object' || options === null || !('sandbox' in options)) return options
  return { ...options, sandbox: sandboxPaths(options.sandbox, base, 'sandbox', missingIn(where)) }
}

/** `(name, fn)`, `(name, options, fn)` as in Vitest, or `(name, fn, options)`. */
function splitArgs<F extends (...args: never[]) => unknown>(
  what: string,
  name: string,
  a: EvalOptions | F | undefined,
  b: EvalOptions | F | undefined,
): [EvalOptions, F] {
  if (typeof a === 'function' && typeof b === 'function') {
    throw new UsageError(
      `${what}("${name}") got two functions. Options must be a plain object; helpers such as secret are only available in defineConfig and defineEnvironment callbacks. Put the secret in an environment (environments: …) or in the config's env.`,
    )
  }
  if (typeof a === 'function') return [(b as EvalOptions | undefined) ?? {}, a]
  if (typeof b === 'function') return [(a as EvalOptions | undefined) ?? {}, b]
  throw new UsageError(
    what === 'group'
      ? `group("${name}") has no function. Pass the group's body, e.g. group("${name}", () => { … }).`
      : `${what}("${name}") has no function. Pass the eval's body, e.g. ${what}("${name}", async (c) => { … }).`,
  )
}

type GroupFn = {
  <N extends number = number>(name: string, fn: () => void, options?: GroupOptions<N>): void
  <N extends number = number>(name: string, options: GroupOptions<N>, fn: () => void): void
}

/** `evaluate.only` and `group.only` are refused in CI, where they'd silently skip the rest. */
function checkOnly(mode: DeclaredMode, what: string): void {
  if (mode !== 'only' || !inCI()) return
  const error = new Error(`${what}.only isn't allowed in CI`)
  error.name = 'OnlyInCiError'
  throw error
}

const defineGroup =
  (mode: DeclaredMode): GroupFn =>
  (name: string, a?: GroupOptions | (() => void), b?: GroupOptions | (() => void)) => {
    checkOnly(mode, 'group')
    const [written, fn] = splitArgs<() => void>('group', name, a, b)
    const options = withPaths(written, `group("${name}")`)
    checkOptions(options, `group("${name}")`)
    const node: DeclaredGroup = { type: 'group', name, mode, options: data(options), children: [] }
    declare(node)
    const stack = [...groupStack, { name, options, node }]
    registerGroup(name, mode, () => {
      const outer = groupStack
      groupStack = stack
      try {
        fn()
      } finally {
        groupStack = outer
      }
    })
  }

export const group: GroupFn & { skip: GroupFn; only: GroupFn; todo: (name: string) => void } =
  Object.assign(defineGroup('run'), {
    skip: defineGroup('skip'),
    only: defineGroup('only'),
    todo: (name: string) => registerTodo(name),
  })

/**
 * A placeholder, `evaluate.todo` or `group.todo`: one eval entry that never runs, counted as
 * skipped and shown as todo. The enclosing groups' tags filter it as they do an eval.
 */
function registerTodo(name: string) {
  declare({ type: 'todo', name })
  const tags = [...new Set(groupStack.flatMap((g) => g.options.tags ?? []))]
  if (matchesTags(tags, getRunContext().tags)) registerTest(name, { mode: 'todo' }, async () => {})
}

/**
 * `N` is `runs.bestOf` as written, so an even or fractional literal is a type error. With
 * `cases`, the body takes the attempt and its case, typed from the list.
 */
type EvaluateFn = {
  <const T, N extends number = number>(
    name: string,
    options: EvalOptions<N> & CaseOptions<T>,
    fn: CaseFn<T>,
  ): void
  <const T, N extends number = number>(
    name: string,
    fn: CaseFn<T>,
    options: EvalOptions<N> & CaseOptions<T>,
  ): void
  <N extends number = number>(name: string, fn: EvalFn, options?: EvalOptions<N>): void
  <N extends number = number>(name: string, options: EvalOptions<N>, fn: EvalFn): void
}

/** `survey`'s calls: `evaluate`'s, with `SurveyOptions`. */
type SurveyFn = {
  <const T>(name: string, options: SurveyOptions & CaseOptions<T>, fn: CaseFn<T>): void
  <const T>(name: string, fn: CaseFn<T>, options: SurveyOptions & CaseOptions<T>): void
  (name: string, fn: EvalFn, options?: SurveyOptions): void
  (name: string, options: SurveyOptions, fn: EvalFn): void
}

/**
 * The evals declared so far, by id, with their name paths and whether each is a family's case,
 * so a second id is refused.
 */
const declared = new Map<string, { path: string[]; inFamily: boolean }>()

/** The pooled families declared so far, by id: their name path, length and the cases seen. */
const families = new Map<string, { path: string[]; cases: number; seen: Set<number> }>()

/** Two name paths with one id differ only where a name holds the ` › ` the id joins them with. */
const separatorHint = (path: string[], earlier: string[]) =>
  path.length === earlier.length
    ? ''
    : ` " › " joins the group and eval names in an eval's id, so a name containing it can be a grouped eval's id.`

/** A run's facts name an eval and a family alike by id, so an eval can't take a family's. */
const namedLikeFamily = (eval_: string[], family: string[]) =>
  new UsageError(
    `evaluate("${eval_.join(' › ')}") has the same id as evaluate("${family.join(' › ')}") with cases in this file. Give one of them another name.${separatorHint(eval_, family)}`,
  )

function checkUnique(
  where: string,
  groups: string[],
  name: string,
  hint: string,
  inFamily: boolean,
): void {
  const path = [...groups, name]
  const id = evalId(collectingFile() ?? '', path)
  const earlier = declared.get(id)
  if (earlier) {
    throw new UsageError(
      `${where} is declared twice in this file. Each eval needs its own name, or its attempts are merged into one eval.${hint}${separatorHint(path, earlier.path)}`,
    )
  }
  const family = inFamily ? undefined : families.get(id)
  if (family) throw namedLikeFamily(path, family.path)
  declared.set(id, { path, inFamily })
}

/**
 * A family's cases pool by its id, the groups and the template, so each case may be declared
 * once and every case must agree on the list's length.
 */
function checkFamily(groups: string[], family: DeclaredFamily): void {
  const path = [...groups, family.name]
  const id = evalId(collectingFile() ?? '', path)
  const earlier = families.get(id)
  if (!earlier) {
    const plain = declared.get(id)
    if (plain && !plain.inFamily) throw namedLikeFamily(plain.path, path)
    families.set(id, { path, cases: family.cases, seen: new Set([family.case]) })
    return
  }
  if (
    earlier.path.length !== path.length ||
    earlier.cases !== family.cases ||
    earlier.seen.has(family.case)
  ) {
    throw new UsageError(
      `evaluate("${path.join(' › ')}") with cases is declared twice in this file. Each eval needs its own name, or their cases are pooled into one. Give each its own name.${separatorHint(path, earlier.path)}`,
    )
  }
  earlier.seen.add(family.case)
}

function register(
  mode: DeclaredMode,
  name: string,
  own: EvalOptions,
  fn: EvalFn,
  source: DeclaredSource,
  hint = '',
  family?: DeclaredFamily,
): void {
  prepare(mode, name, own, fn, source, hint, family).commit()
}

/** An eval planned but not yet registered: `commit` registers its tests. */
type Prepared = { planned: PlannedEval; commit: () => void }

function prepare(
  mode: DeclaredMode,
  name: string,
  own: EvalOptions,
  fn: EvalFn,
  source: DeclaredSource,
  hint = '',
  family?: DeclaredFamily,
  where?: CaseWhere,
): Prepared {
  const groups = groupStack.map((g) => g.name)
  if (family) checkFamily(groups, family)
  checkUnique(`evaluate("${[...groups, name].join(' › ')}")`, groups, name, hint, !!family)
  const body = `b${bodies.size + 1}`
  bodies.set(body, fn)
  declare({
    type: 'eval',
    name,
    mode,
    options: data(own),
    body,
    source,
    ...(family ? { family } : {}),
  })
  const planned = planEval(
    {
      name,
      mode,
      groups: groupStack.map(({ name, options }) => ({ name, options })),
      options: own,
      source,
      ...(family ? { family } : {}),
      ...(where ? { where } : {}),
    },
    { ...getRunContext(), file: collectingFile(), order: registered },
  )
  if (planned.tests) registered++
  const commit = () => {
    declareHarnesses(planned.harnesses)
    if (!planned.tests) return
    const bestOfCells = new Map<string, ReturnType<typeof bestOfCell>>()
    for (const { name: testName, spec, ...options } of planned.tests) {
      const { cell, n, bestOf } = options.attempt
      let hooks = {}
      // A resumed run's completed attempts are skipped, but still settle their place in the cell.
      if (bestOf !== undefined) {
        const of = bestOfCells.get(cell.key) ?? bestOfCell(bestOf)
        bestOfCells.set(cell.key, of)
        hooks = of(n)
      }
      registerTest(
        testName,
        { ...options, ...hooks },
        spec ? (handle) => runAttempt(spec, fn, handle) : async () => {},
      )
    }
  }
  return { planned, commit }
}

/** Evals registered so far in this worker, for the scheduler's tie-break. */
let registered = 0

const defineEval =
  (mode: DeclaredMode, declared?: DeclaredSource, verb: Verb = 'evaluate'): EvaluateFn =>
  (name: string, a?: unknown, b?: unknown) => {
    checkOnly(mode, verb)
    const [split, fn] = splitArgs<EvalFn>(verb, name, a as EvalOptions, b as EvalOptions)
    const where = `${verb}("${name}")`
    const written = verb === 'survey' ? surveyOptions(split, where) : split
    if (isObjectLike(written) && 'where' in written && !('cases' in written)) {
      throw new UsageError(
        `${where} sets where without cases. where picks case-and-environment pairs; to drop an environment, leave it out of environments.`,
      )
    }
    if (isObjectLike(written) && ('cases' in written || 'caseKey' in written)) {
      return registerCases(mode, name, written as EvalOptions & CaseOptions<unknown>, fn, where)
    }
    register(
      mode,
      name,
      withPaths(written, where),
      fn,
      declared ?? { body: bodyHash(fn, where, collectingFile()) },
    )
  }

/**
 * An eval with `cases`: each case plans as a member of a pooled family named for the eval, so its
 * cases pool into one pass rate and, with `compare`, one lift paired by case.
 */
function registerCases(
  mode: DeclaredMode,
  name: string,
  written: EvalOptions & CaseOptions<unknown>,
  fn: EvalFn | CaseFn<unknown>,
  where: string,
): void {
  const { cases, caseKey, where: pick, ...rest } = written
  if (!Array.isArray(cases)) {
    throw new UsageError(
      cases === undefined
        ? `caseKey in ${where} names each case, but there are no cases. Add cases: [...], or drop caseKey.`
        : `cases in ${where} must be a list (got ${typeof cases}), e.g. cases: ['users', 'posts'].`,
    )
  }
  if (cases.length === 0) {
    throw new UsageError(`cases in ${where} is an empty list. Give at least one case.`)
  }
  if (caseKey !== undefined && typeof caseKey !== 'function') {
    throw new UsageError(
      `caseKey in ${where} must be a function from a case to its key, e.g. caseKey: (item) => item.slug.`,
    )
  }
  if (pick !== undefined && typeof pick !== 'function') {
    throw new UsageError(
      `where in ${where} must be a function from a case and an environment to true or false, e.g. where: ({ case: item, environment }) => item.stacks.includes(environment.traits.stack).`,
    )
  }
  if (isObjectLike(rest.runs) && 'bestOf' in rest.runs) {
    throw new UsageError(
      `${where} has cases, so it can't take runs: { bestOf }: best-of stops each cell on its own, and the cases pool over the runs. Set a fixed count, e.g. runs: 3.`,
    )
  }
  const keys = caseKeys(cases, caseKey, where)
  const own = withPaths(rest as EvalOptions, where)
  const file = collectingFile()
  const body = bodyHash(fn, where, file)
  const pooled = cases.length >= 2
  const prepared = cases.map((item, i) => {
    const key = keys[i] as string
    const family = pooled ? { name, case: i, cases: cases.length } : undefined
    const source = { body, case: caseHash(item, `${where} case "${key}"`, file) }
    const run: EvalFn = (c) => (fn as CaseFn<unknown>)(c, item)
    const picks = pick ? { label: where, key, item, where: pick } : undefined
    return prepare(mode, caseEvalName(name, key), own, run, source, '', family, picks)
  })
  if (pick) applyWhere(where, keys, prepared)
  for (const p of prepared) p.commit()
}

/**
 * The checks `where` needs across an eval's cases, then the pairs it left out, on every case's
 * plan: a cell that no case runs on is refused, and so is an eval it leaves nothing to run.
 */
function applyWhere(where: string, keys: string[], prepared: Prepared[]): void {
  const picks = prepared.flatMap((p) => (p.planned.picked ? [p.planned.picked] : []))
  if (!picks.length) return
  const excluded = picks.flatMap((p) => p.excluded)
  const kept = new Set(picks.flatMap((p) => p.keptCells))
  if (!kept.size) {
    throw new UsageError(
      `${where}'s where excludes all ${excluded.length} case-and-environment pairs, so it has nothing to run.`,
    )
  }
  const empty = picks.flatMap((p) => p.cells).find((c) => !kept.has(c.key))
  if (empty) {
    throw new UsageError(
      `${where}'s where leaves cell ${empty.key} with no cases. Leave ${empty.environment} out of environments, or widen where.`,
    )
  }
  if (!excluded.length) return
  const byEnv = new Map<string, string[]>()
  for (const e of excluded) {
    const on = e.harness ? `${e.environment} for ${e.harness}` : e.environment
    const list = byEnv.get(on) ?? []
    if (!list.includes(e.case)) list.push(e.case)
    byEnv.set(on, list)
  }
  const order = (k: string) => keys.indexOf(k)
  const notes = [
    `where excludes ${excluded.length} ${excluded.length === 1 ? 'pair' : 'pairs'}`,
    ...[...byEnv].map(
      ([on, list]) => `excluded on ${on}: ${list.sort((a, b) => order(a) - order(b)).join(', ')}`,
    ),
  ]
  const plans = new Set(prepared.flatMap((p) => (p.planned.tests ?? []).map((t) => t.attempt.plan)))
  for (const plan of plans) plan.excluded = excluded
  // A completed attempt's plan is a copy that shares its notes.
  for (const list of new Set([...plans].map((p) => p.notes))) list.push(...notes)
}

export const evaluate: EvaluateFn & {
  skip: EvaluateFn
  only: EvaluateFn
  todo: (name: string) => void
} = Object.assign(defineEval('run'), {
  skip: defineEval('skip'),
  only: defineEval('only'),
  todo: registerTodo,
})

type Verb = 'evaluate' | 'survey'

/**
 * A survey's options as an eval's: the gate fixed at `'none'`. A gate of its own, or its compare's
 * `gate` or `minLift`, is refused, since nothing in a survey gates.
 */
function surveyOptions(written: EvalOptions, where: string): EvalOptions {
  if (!isObjectLike(written)) return written
  const fix = 'A survey records what its attempts do and gates nothing; use evaluate() to gate.'
  if ('gate' in written) throw new UsageError(`${where} sets gate. ${fix}`)
  if (isObjectLike(written.runs)) {
    throw new UsageError(
      `${where} sets runs: { bestOf }, which gates each cell on its majority. ${fix} Set a fixed count, e.g. runs: 3.`,
    )
  }
  const compare: unknown = written.compare
  for (const key of ['gate', 'minLift'] as const) {
    if (isObjectLike(compare) && key in compare) {
      throw new UsageError(`${where} sets compare.${key}. ${fix}`)
    }
  }
  return { ...written, gate: 'none' }
}

/**
 * `survey` is `evaluate` with the gate fixed at `'none'`: its attempts run and are recorded, and
 * only run and infra errors fail it. A failed `expect` reads as a check that failed, not a fail.
 */
export const survey: SurveyFn & {
  skip: SurveyFn
  only: SurveyFn
  todo: (name: string) => void
} = Object.assign(defineEval('run', undefined, 'survey') as SurveyFn, {
  skip: defineEval('skip', undefined, 'survey') as SurveyFn,
  only: defineEval('only', undefined, 'survey') as SurveyFn,
  todo: registerTodo,
})

/**
 * Declares a tree's groups and evals as the calls that made it would, in the file being
 * collected; `bodyFor` gives each eval's body by its id. A tree from another language is
 * checked against the contract first. Its relative host paths resolve against the directory of
 * the file being collected, as a TypeScript eval file's do against its own.
 */
export function declareTree(nodes: readonly DeclaredNode[], bodyFor: (id: string) => EvalFn): void {
  const problem = declarationProblem(nodes)
  if (problem) throw new UsageError(problem)
  const file = collectingFile()
  declareNodes(nodes, bodyFor, file ? dirname(file) : process.cwd())
}

function declareNodes(
  nodes: readonly DeclaredNode[],
  bodyFor: (id: string) => EvalFn,
  base: string,
): void {
  for (const node of nodes) {
    if (node.type === 'todo') registerTodo(node.name)
    else if (node.type === 'group') {
      const children = node.children
      const where = `group("${node.name}")`
      defineGroup(node.mode)(node.name, optionsFrom(node.options, where, base), () =>
        declareNodes(children, bodyFor, base),
      )
    } else if (node.family) {
      const options = optionsFrom(node.options, `evaluate("${node.name}")`, base)
      checkOnly(node.mode, 'evaluate')
      register(node.mode, node.name, options, bodyFor(node.body), node.source, '', node.family)
    } else
      defineEval(node.mode, node.source)(
        node.name,
        optionsFrom(node.options, `evaluate("${node.name}")`, base),
        bodyFor(node.body),
      )
  }
}

/**
 * Options from their data forms, with host paths absolute against `base`: environments become
 * `Environment`s again.
 */
function optionsFrom(written: EvalOptionsData, where: string, base: string): EvalOptions {
  refuseIllegalCompare(written, where)
  const resolved = withPaths(written as GroupOptions, where, base) as EvalOptionsData
  const { environments, compare, ...rest } = resolved
  const missing = missingIn(where)
  const asEnv = (env: EnvironmentData, field: string) =>
    environmentFrom(environmentPaths(env, base, field, missing) as EnvironmentData)
  const asEnvs = (value: EnvironmentsData, field: string): EnvironmentsData<Environment> => {
    if (Array.isArray(value)) return value.map((e, i) => asEnv(e, `${field}[${i}]`))
    if ('only' in value) return value
    if ('add' in value) {
      return { add: [value.add].flat().map((e, i) => asEnv(e, `${field}.add[${i}]`)) }
    }
    return asEnv(value, field)
  }
  const own =
    environments !== undefined ? { environments: asEnvs(environments, 'environments') } : {}
  if (compare === undefined) return { ...rest, ...own }
  const variants = compare.variants.map((v, i) => asEnv(v, `compare.variants[${i}]`))
  return {
    ...rest,
    compare: { ...compare, control: asEnv(compare.control, 'compare.control'), variants },
  }
}
