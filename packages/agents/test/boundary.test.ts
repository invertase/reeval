// @reeval/agents runs harnesses and records what they did, and nothing else: reeval builds evals
// and environments on top of it, so nothing here may reach reeval or name its concepts. These
// tests walk every module in src/ and refuse an import of anything but another module in src/, a
// `node:` builtin or one of the package's own dependencies, and an exported name from an eval or
// from the environment a harness runs in.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')
const src = join(root, 'src')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}
const DEPENDENCIES = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
])

/**
 * What an exported name may not start with: a type or class named for one of reeval's eval
 * concepts, or anything named for its environment layer (egress, brokering, its gateway).
 */
const EVAL_TYPE =
  /^(Attempt|Eval|Evaluation|Judge|Plan|Bundle|Gate|Matcher|Cell|RunRecord|Assertion)(?![a-z])/
const ENVIRONMENT = /^(egress|broker|gateway|substitution)/i
const refusedName = (name: string) => EVAL_TYPE.test(name) || ENVIRONMENT.test(name)

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(join(dir, e.name))
      : /\.[cm]?ts$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  )

/**
 * The code without its comments, each string literal replaced by `'#<n>'` for its index in
 * `strings`, so a regex over `code` never matches inside a comment or a string.
 */
function tokens(text: string): { code: string; strings: string[] } {
  const strings: string[] = []
  let code = ''
  let i = 0
  while (i < text.length) {
    const c = text[i] as string
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
      code += ' '
    } else if (c === "'" || c === '"' || c === '`') {
      const start = ++i
      while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1
      strings.push(text.slice(start, i++))
      code += `'#${strings.length - 1}'`
    } else {
      code += c
      i++
    }
  }
  return { code, strings }
}

const SPECIFIER =
  /(?:^|[;}\n])\s*(?:import|export)\s[^;]*?\bfrom\s*'#(\d+)'|(?:^|[;}\n])\s*import\s*'#(\d+)'|\b(?:import|require)\(\s*'#(\d+)'\s*\)/g

/** Every module specifier a file imports or re-exports from. */
function specifiers(text: string): string[] {
  const { code, strings } = tokens(text)
  return [...code.matchAll(SPECIFIER)].map((m) => strings[Number(m[1] ?? m[2] ?? m[3])] as string)
}

/** The package a bare specifier names: `@scope/name` or `name`, without a subpath. */
const packageOf = (specifier: string) =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/')

/** Why `specifier`, imported from `file`, is refused, or undefined when it's allowed. */
function refusal(file: string, specifier: string): string | undefined {
  if (specifier.startsWith('node:')) return undefined
  if (specifier.startsWith('.')) {
    return relative(src, resolve(dirname(file), specifier)).startsWith('..')
      ? `${specifier} is outside src/: the package imports nothing of reeval's`
      : undefined
  }
  const name = packageOf(specifier)
  return DEPENDENCIES.has(name) ? undefined : `${name} isn't one of the package's dependencies`
}

const DECLARED =
  /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function\*?|class|type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/g
const LISTED = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g

/** The names a module exports, as it declares or lists them. */
function exportedNames(text: string): string[] {
  const { code } = tokens(text)
  const listed = [...code.matchAll(LISTED)].flatMap((m) =>
    (m[1] as string).split(',').map((part) =>
      (
        part
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)
          .pop() ?? ''
      ).trim(),
    ),
  )
  return [...[...code.matchAll(DECLARED)].map((m) => m[1] as string), ...listed].filter(Boolean)
}

test('every module imports only src/, node: builtins and the package dependencies', () => {
  const problems = sourceFiles(src).flatMap((file) =>
    specifiers(readFileSync(file, 'utf8')).flatMap((s) => {
      const why = refusal(file, s)
      return why ? [`${relative(root, file)}: ${why}`] : []
    }),
  )
  assert.deepEqual(problems, [])
})

test('no exported name is an eval or environment concept', () => {
  const problems = sourceFiles(src).flatMap((file) =>
    exportedNames(readFileSync(file, 'utf8'))
      .filter(refusedName)
      .map((name) => `${relative(root, file)}: ${name}`),
  )
  assert.deepEqual(problems, [])
})

test('the checks refuse what they are meant to', () => {
  const file = join(src, 'driver', 'agent.ts')
  const text = [
    `import { a } from '../index.ts'`,
    `import type { Attempt } from '../../../reeval/src/types.ts'`,
    `export { run } from 'reeval'`,
    `import 'node:fs'`,
    `const lazy = await import('@reeval/sandbox-docker/process')`,
    `// import { gone } from 'commented-out'`,
    `/* export * from 'also-commented-out' */`,
    `const s = "import { no } from 'in-a-string'"`,
    `export type AttemptOptions = {}`,
    `export const brokerToken = 1`,
    `export { x as EgressPolicy, type HarnessResult }`,
    `export function checkAgent() {}`,
    `export type Platform = string`,
    `export const planned = 1`,
  ].join('\n')
  assert.deepEqual(
    specifiers(text).map((s) => [s, refusal(file, s)]),
    [
      ['../index.ts', undefined],
      [
        '../../../reeval/src/types.ts',
        "../../../reeval/src/types.ts is outside src/: the package imports nothing of reeval's",
      ],
      ['reeval', "reeval isn't one of the package's dependencies"],
      ['node:fs', undefined],
      [
        '@reeval/sandbox-docker/process',
        "@reeval/sandbox-docker isn't one of the package's dependencies",
      ],
    ],
  )
  assert.deepEqual(exportedNames(text).filter(refusedName), [
    'AttemptOptions',
    'brokerToken',
    'EgressPolicy',
  ])
})
