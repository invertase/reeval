import { dirname } from 'node:path'
import { runAttempt } from './attempt/index.ts'
import { bestOfCell } from './best-of.ts'
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
import { planEval } from './plan-eval.ts'
import { redactSecrets } from './redact.ts'
import type {
  AttemptContext,
  EnvironmentData,
  EvalFn,
  EvalOptions,
  EvalOptionsData,
  GroupOptions,
} from './types.ts'

/** `name` is as it's shown, masked; `given` is as the file wrote it. */
type Declaring = { name: string; given: string; options: GroupOptions; node: DeclaredGroup }

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
      `${what}("${name}") got two functions. Options must be a plain object; helpers such as secret are only available in defineConfig and defineEnvironment callbacks. Put the secret in an environment (environment: …) or in the config's env.`,
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

/** Each name path as its file wrote it, by kind and the path it's shown as. */
const givenPaths = new Map<string, string>()

/**
 * `name` as it's declared, recorded and shown: masked as everything reeval writes is, so the
 * eval's id, its artifact directory and every view hold no secret. Two names that mask to the
 * same name are refused rather than numbered: the id is the key history, compare and query
 * group attempts by across runs, and a number would depend on the order of the declarations.
 */
function shownName(kind: 'eval' | 'group' | 'todo', name: string, hint = ''): string {
  const shown = redactSecrets(name)
  const path = [...groupStack.map((g) => g.name), shown]
  const given = [...groupStack.map((g) => g.given), name].join('\0')
  const key = [collectingFile() ?? '', kind, ...path].join('\0')
  const earlier = givenPaths.get(key)
  if (earlier !== undefined && earlier !== given) {
    const what = kind === 'group' ? 'group' : kind === 'todo' ? 'evaluate.todo' : 'evaluate'
    throw new UsageError(
      `${what}("${path.join(' › ')}") names a secret, and its masked name is another ${kind === 'group' ? 'group' : 'eval'}'s in this file: name it without the secret.${hint}`,
    )
  }
  givenPaths.set(key, given)
  return shown
}

const defineGroup =
  (mode: DeclaredMode): GroupFn =>
  (given: string, a?: GroupOptions | (() => void), b?: GroupOptions | (() => void)) => {
    checkOnly(mode, 'group')
    const name = shownName('group', given)
    const [written, fn] = splitArgs<() => void>('group', name, a, b)
    const options = withPaths(written, `group("${name}")`)
    checkOptions(options, `group("${name}")`)
    const node: DeclaredGroup = { type: 'group', name, mode, options: data(options), children: [] }
    declare(node)
    const stack = [...groupStack, { name, given, options, node }]
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
function registerTodo(given: string) {
  const name = shownName('todo', given)
  declare({ type: 'todo', name })
  const tags = [...new Set(groupStack.flatMap((g) => g.options.tags ?? []))]
  if (matchesTags(tags, getRunContext().tags)) registerTest(name, { mode: 'todo' }, async () => {})
}

/** `N` is `runs.bestOf` as written, so an even or fractional literal is a type error. */
type EvaluateFn<F = EvalFn> = {
  <N extends number = number>(name: string, fn: F, options?: EvalOptions<N>): void
  <N extends number = number>(name: string, options: EvalOptions<N>, fn: F): void
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
    `evaluate("${eval_.join(' › ')}") has the same id as the pooled evaluate.each("${family.join(' › ')}") in this file: a family's id is its name template. Give the eval or the template another name.${separatorHint(eval_, family)}`,
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
      `evaluate.each("${path.join(' › ')}") is declared twice in this file. Each pooled evaluate.each needs its own name, or their cases are pooled into one family. Give each its own name template, or pass evaluate.each(cases, { pool: false }) to keep the cases apart.${separatorHint(path, earlier.path)}`,
    )
  }
  earlier.seen.add(family.case)
}

function register(
  mode: DeclaredMode,
  given: string,
  own: EvalOptions,
  fn: EvalFn,
  source: DeclaredSource,
  hint = '',
  givenFamily?: DeclaredFamily,
): void {
  const name = shownName(
    'eval',
    given,
    hint && ' For evaluate.each, name each case by %# or by a field that holds no secret.',
  )
  const family = givenFamily && { ...givenFamily, name: redactSecrets(givenFamily.name) }
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
  const { tests, harnesses } = planEval(
    {
      name,
      mode,
      groups: groupStack.map(({ name, options }) => ({ name, options })),
      options: own,
      source,
      ...(family ? { family } : {}),
    },
    { ...getRunContext(), file: collectingFile(), order: registered },
  )
  declareHarnesses(harnesses)
  if (!tests) return
  registered++
  const bestOfCells = new Map<string, ReturnType<typeof bestOfCell>>()
  for (const { name: testName, spec, ...options } of tests) {
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

/** Evals registered so far in this worker, for the scheduler's tie-break. */
let registered = 0

const defineEval =
  (mode: DeclaredMode, declared?: DeclaredSource): EvaluateFn =>
  (name: string, a?: EvalOptions | EvalFn, b?: EvalOptions | EvalFn) => {
    checkOnly(mode, 'evaluate')
    const shown = redactSecrets(name)
    const [own, fn] = splitArgs<EvalFn>('evaluate', shown, a, b)
    const where = `evaluate("${shown}")`
    register(
      mode,
      name,
      withPaths(own, where),
      fn,
      declared ?? { body: bodyHash(fn, where, collectingFile()) },
    )
  }

/** `$key` is a property of the case, `%s` the case itself, `%#` its index. */
function formatName(template: string, item: unknown, index: number): string {
  return template
    .replace(/%#/g, String(index))
    .replace(/%s/g, typeof item === 'string' ? item : JSON.stringify(item))
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, key: string) =>
      isObjectLike(item) && key in item ? String(item[key]) : whole,
    )
}

/** How an `evaluate.each` treats its cases. */
export type EachOptions = {
  /**
   * Pool the cases into one suite: a pass rate over them and, with `compare`, one paired lift
   * that `minLift` gates. On by default; `false` keeps them independent evals.
   */
  pool?: boolean
}

function checkEachOptions(options: unknown): EachOptions {
  if (options === undefined) return {}
  if (isObjectLike(options) && Object.keys(options).every((k) => k === 'pool')) {
    const { pool } = options
    if (pool === undefined) return {}
    if (typeof pool === 'boolean') return { pool }
  }
  throw new UsageError(
    `evaluate.each(cases, options) takes { pool?: boolean } (got ${JSON.stringify(options)}). Eval options such as compare go after the name: evaluate.each(cases)(name, { compare }, fn).`,
  )
}

/**
 * One eval per case, pooled into one suite:
 * `evaluate.each(cases)('adds $a and $b', async (c, { a, b }) => …)`.
 */
const evalEach =
  <T>(
    cases: readonly T[],
    options?: EachOptions,
  ): EvaluateFn<(c: AttemptContext, item: T) => Promise<void>> =>
  (name: string, a?: unknown, b?: unknown) => {
    const { pool = true } = checkEachOptions(options)
    if (!Array.isArray(cases)) {
      throw new UsageError(
        `evaluate.each takes an array of cases (got ${typeof cases}), e.g. evaluate.each([{ n: 1 }, { n: 2 }])("case $n", async (c, item) => { … }).`,
      )
    }
    const template = redactSecrets(name)
    const [written, fn] = splitArgs<(c: AttemptContext, item: T) => Promise<void>>(
      'evaluate.each',
      template,
      a as EvalOptions,
      b as EvalOptions,
    )
    const own = withPaths(written, `evaluate.each("${template}")`)
    const hint = ` For evaluate.each, put $key, %s or %# in the name ("${template}") so each case's name differs.`
    const pooled = pool && cases.length >= 2
    const file = collectingFile()
    const body = bodyHash(fn, `evaluate.each("${template}")`, file)
    cases.forEach((item, i) => {
      const family = pooled ? { name, case: i, cases: cases.length } : undefined
      const source = { body, case: caseHash(item, `evaluate.each("${template}") case ${i}`, file) }
      register('run', formatName(name, item, i), own, (c) => fn(c, item), source, hint, family)
    })
  }

export const evaluate: EvaluateFn & {
  skip: EvaluateFn
  only: EvaluateFn
  todo: (name: string) => void
  each: typeof evalEach
} = Object.assign(defineEval('run'), {
  skip: defineEval('skip'),
  only: defineEval('only'),
  todo: registerTodo,
  each: evalEach,
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
  const { environment, compare, ...rest } = resolved
  const missing = missingIn(where)
  const asEnv = (env: EnvironmentData, field: string) =>
    environmentFrom(environmentPaths(env, base, field, missing) as EnvironmentData)
  const own = environment !== undefined ? { environment: asEnv(environment, 'environment') } : {}
  if (compare === undefined) return { ...rest, ...own }
  const variants = compare.variants.map((v, i) => asEnv(v, `compare.variants[${i}]`))
  if (compare.baseline !== undefined) {
    return {
      ...rest,
      compare: { ...compare, baseline: asEnv(compare.baseline, 'compare.baseline'), variants },
    }
  }
  return { ...rest, ...own, compare: { ...compare, variants } }
}
