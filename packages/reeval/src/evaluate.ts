import { runAttempt } from './attempt/index.ts'
import { declarationProblem } from './contract/declaration.ts'
import type {
  DeclarationTree,
  DeclaredFamily,
  DeclaredGroup,
  DeclaredMode,
  DeclaredNode,
} from './declaration.ts'
import { collectingFile, getRunContext, registerGroup, registerTest } from './engine/runtime.ts'
import { inCI } from './env.ts'
import { callerDir, environmentFrom, sandboxPaths } from './environment.ts'
import { UsageError } from './errors.ts'
import { checkOptions, matchesTags, refuseIllegalCompare } from './options.ts'
import { planEval } from './plan-eval.ts'
import type {
  AttemptContext,
  EnvironmentData,
  EvalFn,
  EvalOptions,
  EvalOptionsData,
  GroupOptions,
} from './types.ts'

export type { EvalOptions, GroupOptions }

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

/**
 * The options with a `sandbox` written as data given absolute host paths against the eval file,
 * as `docker()` and `fakeSandbox()` resolve theirs against the file that calls them.
 */
function withPaths<T extends GroupOptions>(options: T, where: string): T {
  if (typeof options !== 'object' || options === null || !('sandbox' in options)) return options
  const sandbox = sandboxPaths(
    options.sandbox,
    callerDir() ?? process.cwd(),
    'sandbox',
    (field, full) => {
      throw new UsageError(
        `${field} in ${where}: ${full} doesn't exist. Paths are relative to the file that declares it.`,
      )
    },
  )
  return { ...options, sandbox }
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
  (name: string, fn: () => void, options?: GroupOptions): void
  (name: string, options: GroupOptions, fn: () => void): void
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

type EvaluateFn<F = EvalFn> = {
  (name: string, fn: F, options?: EvalOptions): void
  (name: string, options: EvalOptions, fn: F): void
}

/** The evals declared so far, by file and name path, so a second one with the same id is refused. */
const declared = new Set<string>()

function checkUnique(where: string, groups: string[], name: string, hint: string): void {
  const key = `${collectingFile() ?? ''}\0${[...groups, name].join('\0')}`
  if (declared.has(key)) {
    throw new UsageError(
      `${where} is declared twice in this file. Each eval needs its own name, or its attempts are merged into one eval.${hint}`,
    )
  }
  declared.add(key)
}

function register(
  mode: DeclaredMode,
  name: string,
  own: EvalOptions,
  fn: EvalFn,
  hint = '',
  family?: DeclaredFamily,
): void {
  const groups = groupStack.map((g) => g.name)
  checkUnique(`evaluate("${[...groups, name].join(' › ')}")`, groups, name, hint)
  const body = `b${bodies.size + 1}`
  bodies.set(body, fn)
  declare({ type: 'eval', name, mode, options: data(own), body, ...(family ? { family } : {}) })
  const tests = planEval(
    {
      name,
      mode,
      groups: groupStack.map(({ name, options }) => ({ name, options })),
      options: own,
      ...(family ? { family } : {}),
    },
    { ...getRunContext(), file: collectingFile(), order: registered },
  )
  if (!tests) return
  registered++
  for (const { name: testName, spec, ...options } of tests)
    registerTest(
      testName,
      options,
      spec ? (handle) => runAttempt(spec, fn, handle) : async () => {},
    )
}

/** Evals registered so far in this worker, for the scheduler's tie-break. */
let registered = 0

const defineEval =
  (mode: DeclaredMode): EvaluateFn =>
  (name: string, a?: EvalOptions | EvalFn, b?: EvalOptions | EvalFn) => {
    checkOnly(mode, 'evaluate')
    const [own, fn] = splitArgs<EvalFn>('evaluate', name, a, b)
    register(mode, name, withPaths(own, `evaluate("${name}")`), fn)
  }

/** `$key` is a property of the case, `%s` the case itself, `%#` its index. */
function formatName(template: string, item: unknown, index: number): string {
  return template
    .replace(/%#/g, String(index))
    .replace(/%s/g, typeof item === 'string' ? item : JSON.stringify(item))
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, key: string) =>
      typeof item === 'object' && item !== null && key in item
        ? String((item as Record<string, unknown>)[key])
        : whole,
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
  const keys = typeof options === 'object' && options !== null ? Object.keys(options) : null
  const pool = (options as EachOptions | null)?.pool
  if (keys?.every((k) => k === 'pool') && (pool === undefined || typeof pool === 'boolean'))
    return options as EachOptions
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
    const [written, fn] = splitArgs<(c: AttemptContext, item: T) => Promise<void>>(
      'evaluate.each',
      name,
      a as EvalOptions,
      b as EvalOptions,
    )
    const own = withPaths(written, `evaluate.each("${name}")`)
    const hint = ` For evaluate.each, put $key, %s or %# in the name ("${name}") so each case's name differs.`
    const pooled = pool && cases.length >= 2
    cases.forEach((item, i) => {
      const family = pooled ? { name, case: i, cases: cases.length } : undefined
      register('run', formatName(name, item, i), own, (c) => fn(c, item), hint, family)
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
 * checked against the contract first.
 */
export function declareTree(nodes: readonly DeclaredNode[], bodyFor: (id: string) => EvalFn): void {
  const problem = declarationProblem(nodes)
  if (problem) throw new UsageError(problem)
  declareNodes(nodes, bodyFor)
}

function declareNodes(nodes: readonly DeclaredNode[], bodyFor: (id: string) => EvalFn): void {
  for (const node of nodes) {
    if (node.type === 'todo') registerTodo(node.name)
    else if (node.type === 'group') {
      const children = node.children
      defineGroup(node.mode)(node.name, optionsFrom(node.options, `group("${node.name}")`), () =>
        declareNodes(children, bodyFor),
      )
    } else if (node.family) {
      const options = optionsFrom(node.options, `evaluate("${node.name}")`)
      checkOnly(node.mode, 'evaluate')
      register(node.mode, node.name, options, bodyFor(node.body), '', node.family)
    } else
      defineEval(node.mode)(
        node.name,
        optionsFrom(node.options, `evaluate("${node.name}")`),
        bodyFor(node.body),
      )
  }
}

/** Options from their data forms: environments become `Environment`s again. */
function optionsFrom(data: EvalOptionsData, where: string): EvalOptions {
  refuseIllegalCompare(data, where)
  const { environment, compare, ...rest } = data
  const asEnv = (env: EnvironmentData) => environmentFrom(env)
  if (compare === undefined) {
    return {
      ...rest,
      ...(environment !== undefined ? { environment: asEnv(environment) } : {}),
    }
  }
  if (compare.baseline !== undefined) {
    return {
      ...rest,
      compare: {
        ...compare,
        baseline: asEnv(compare.baseline),
        variants: compare.variants.map(asEnv),
      },
    }
  }
  return {
    ...rest,
    ...(environment !== undefined ? { environment: asEnv(environment) } : {}),
    compare: { ...compare, variants: compare.variants.map(asEnv) },
  }
}
