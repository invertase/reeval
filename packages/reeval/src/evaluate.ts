import { runAttempt } from './attempt/index.ts'
import type { DeclarationTree, DeclaredGroup, DeclaredMode, DeclaredNode } from './declaration.ts'
import { collectingFile, getRunContext, registerGroup, registerTest } from './engine/runtime.ts'
import { inCI } from './env.ts'
import { environmentFrom } from './environment.ts'
import { UsageError } from './errors.ts'
import { checkOptions, matchesTags } from './options.ts'
import { planEval } from './plan-eval.ts'
import type {
  EnvironmentData,
  EvalContext,
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
      : `${what}("${name}") has no function. Pass the eval's body, e.g. ${what}("${name}", async (t) => { … }).`,
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
    const [options, fn] = splitArgs<() => void>('group', name, a, b)
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

function register(mode: DeclaredMode, name: string, own: EvalOptions, fn: EvalFn, hint = ''): void {
  const groups = groupStack.map((g) => g.name)
  checkUnique(`evaluate("${[...groups, name].join(' › ')}")`, groups, name, hint)
  const body = `b${bodies.size + 1}`
  bodies.set(body, fn)
  declare({ type: 'eval', name, mode, options: data(own), body })
  const tests = planEval(
    {
      name,
      mode,
      groups: groupStack.map(({ name, options }) => ({ name, options })),
      options: own,
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
    register(mode, name, own, fn)
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

/** One eval per case: `evaluate.for(cases)('adds $a and $b', async (t, c) => …)`. */
const evalFor =
  <T>(cases: readonly T[]): EvaluateFn<(t: EvalContext, item: T) => Promise<void>> =>
  (name: string, a?: unknown, b?: unknown) => {
    const [own, fn] = splitArgs<(t: EvalContext, item: T) => Promise<void>>(
      'evaluate.for',
      name,
      a as EvalOptions,
      b as EvalOptions,
    )
    const hint = ` For evaluate.for, put $key, %s or %# in the name ("${name}") so each case's name differs.`
    cases.forEach((item, i) => {
      register('run', formatName(name, item, i), own, (t) => fn(t, item), hint)
    })
  }

export const evaluate: EvaluateFn & {
  skip: EvaluateFn
  only: EvaluateFn
  todo: (name: string) => void
  for: typeof evalFor
} = Object.assign(defineEval('run'), {
  skip: defineEval('skip'),
  only: defineEval('only'),
  todo: registerTodo,
  for: evalFor,
})

/**
 * Declares a tree's groups and evals as the calls that made it would, in the file being
 * collected; `bodyFor` gives each eval's body by its id.
 */
export function declareTree(nodes: readonly DeclaredNode[], bodyFor: (id: string) => EvalFn): void {
  for (const node of nodes) {
    if (node.type === 'todo') registerTodo(node.name)
    else if (node.type === 'group') {
      const children = node.children
      defineGroup(node.mode)(node.name, optionsFrom(node.options), () =>
        declareTree(children, bodyFor),
      )
    } else defineEval(node.mode)(node.name, optionsFrom(node.options), bodyFor(node.body))
  }
}

/** Options from their data forms: environments become `Environment`s again. */
function optionsFrom({ environment, compare, ...rest }: EvalOptionsData): EvalOptions {
  const asEnv = (data: EnvironmentData) => environmentFrom(data)
  if (compare !== undefined && compare !== false) {
    const revived = {
      ...rest,
      compare: {
        ...compare,
        baseline: asEnv(compare.baseline),
        variants: compare.variants.map(asEnv),
      },
    }
    // Invalid data may set both. Keep `environment` so checkOptions names both keys.
    return (
      environment === undefined ? revived : { ...revived, environment: asEnv(environment) }
    ) as EvalOptions
  }
  return {
    ...rest,
    ...(environment !== undefined ? { environment: asEnv(environment) } : {}),
    ...(compare === false ? { compare: false } : {}),
  }
}
