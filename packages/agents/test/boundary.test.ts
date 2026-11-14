// @reeval/agents runs harnesses and records what they did, and nothing else: reeval builds evals
// and environments on top of it, so nothing here may reach reeval or name its concepts. These
// tests parse every module in src/ and refuse an import of anything but another module in src/, a
// `node:` builtin or one of the package's own dependencies, and an exported name for an eval
// concept or for the environment a harness runs in. Biome refuses `reeval` too, but not through
// `require`, and tsc resolves the root's `reeval` devDependency, so this is the one full check.
// A specifier computed at run time (`import('ree' + 'val')`) is refused rather than read; a call
// through `createRequire(…)` is the one load no static check can see.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { parseSync } from 'oxc-parser'

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

/** Types and classes named for one of reeval's eval concepts: the word, then the next word. */
const EVAL_PREFIX =
  /^(Attempt|Eval|Evaluation|Judge|Bundle|Gate|Matcher|Cell|RunRecord|Assertion)(?![a-z])/
/** reeval's own plan names; a harness's plan (a permission mode, a plan tool) stays allowed. */
const EVAL_PLAN_NAMES = new Set([
  'Plan',
  'PlanCase',
  'PlanCell',
  'PlanContext',
  'PlanCost',
  'PlanCostCell',
  'PlanDoc',
  'PlanDocument',
  'PlanEgress',
  'PlanEval',
  'PlanImage',
  'PlanInput',
  'PlanQuestion',
  'PlanRow',
  'Planned',
  'PlannedAttempt',
  'PlannedEgress',
  'PlannedEval',
  'PlannedItem',
  'PlannedJudge',
  'PlannedPhaseEgress',
  'PlannedQuestion',
  'PlannedSecret',
  'PlannedTest',
])
/** Anything named for reeval's environment layer: egress, brokering, its gateway. */
const ENVIRONMENT = /^(egress|broker|gateway|substitution)/i
const refusedName = (name: string) =>
  EVAL_PREFIX.test(name) || EVAL_PLAN_NAMES.has(name) || ENVIRONMENT.test(name)

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(join(dir, e.name))
      : /\.[cm]?tsx?$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  )

type Node = { type: string; [key: string]: unknown }
const isNode = (v: unknown): v is Node =>
  typeof v === 'object' && v !== null && typeof (v as Node).type === 'string'

function parse(file: string, text: string) {
  const result = parseSync(file, text, { sourceType: 'module', lang: 'ts' })
  if (result.errors.length) {
    throw new Error(`${file}: ${result.errors.map((e) => e.message).join('; ')}`)
  }
  return result
}

/** A string literal or a template literal without expressions, else undefined. */
function literal(node: unknown): string | undefined {
  if (!isNode(node)) return undefined
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral' && (node.expressions as unknown[]).length === 0) {
    const [quasi] = node.quasis as { value: { cooked: string | null } }[]
    return quasi?.value.cooked ?? undefined
  }
  return undefined
}

/** What a module loads: each specifier, or `null` for one computed at run time. */
function loads(file: string, text: string): (string | null)[] {
  const { program, comments } = parse(file, text)
  const out: (string | null)[] = []
  const visit = (node: Node) => {
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
        if (node.source) out.push(literal(node.source) ?? null)
        break
      case 'ImportExpression':
      case 'TSImportType':
        out.push(literal(node.source) ?? null)
        break
      case 'TSExternalModuleReference':
        out.push(literal(node.expression) ?? null)
        break
      case 'CallExpression': {
        const callee = node.callee as Node
        if (callee.type === 'Identifier' && callee.name === 'require') {
          out.push(literal((node.arguments as unknown[])[0]) ?? null)
        }
        break
      }
    }
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) if (isNode(child)) visit(child)
    }
  }
  visit(program as unknown as Node)
  for (const c of comments) {
    const ref = c.type === 'Line' && /^\/\s*<reference\s+(types|path)\s*=\s*"([^"]+)"/.exec(c.value)
    if (!ref) continue
    const [, kind, target = ''] = ref
    out.push(kind === 'path' && !target.startsWith('.') ? `./${target}` : target)
  }
  return out
}

/** The package a bare specifier names: `@scope/name` or `name`, without a subpath. */
const packageOf = (specifier: string) =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/')

/** Why loading `specifier` from `file` is refused, or undefined when it's allowed. */
function refusal(file: string, specifier: string | null): string | undefined {
  if (specifier === null) return "a specifier computed at run time can't be checked"
  if (specifier.startsWith('node:')) return undefined
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return relative(src, resolve(dirname(file), specifier)).startsWith('..')
      ? `${specifier} is outside src/: the package imports nothing of reeval's`
      : undefined
  }
  const name = packageOf(specifier)
  return DEPENDENCIES.has(name) ? undefined : `${name} isn't one of the package's dependencies`
}

/** Every name a module exports, however it declares, destructures, lists or re-exports it. */
const exportedNames = (file: string, text: string): string[] =>
  parse(file, text).module.staticExports.flatMap((e) =>
    e.entries.flatMap((entry) =>
      entry.exportName.kind === 'Name' && entry.exportName.name ? [entry.exportName.name] : [],
    ),
  )

const problems = (check: (file: string, text: string) => string[]) =>
  sourceFiles(src).flatMap((file) =>
    check(file, readFileSync(file, 'utf8')).map((p) => `${relative(root, file)}: ${p}`),
  )

test('every module imports only src/, node: builtins and the package dependencies', () => {
  const refused = problems((file, text) => loads(file, text).flatMap((s) => refusal(file, s) ?? []))
  assert.deepEqual(refused, [])
})

test('no exported name is an eval or environment concept', () => {
  assert.deepEqual(
    problems((file, text) => exportedNames(file, text).filter(refusedName)),
    [],
  )
})

test('the checks refuse what they are meant to', () => {
  const file = join(src, 'driver', 'agent.ts')
  const text = [
    `/// <reference types="reeval" />`,
    `/// <reference path="../../../reeval/src/types.d.ts" />`,
    `/// <reference lib="es2023" />`,
    `import { a } from '../index.ts'`,
    `import type { Attempt } from '../../../reeval/src/types.ts'`,
    `import { type RunRecord } from 'reeval'`,
    `import{b}from'reeval/view'`,
    `export{c}from'reeval/judge'`,
    `import 'node:fs'`,
    `import {`,
    `  d,`,
    `} from '@reeval/sandbox-docker'`,
    `const quote = /['"]/`,
    `import e from 'after-a-regex-quote'`,
    `export const lazy = () => require('reeval/harness')`,
    `export const later = () => import('@ai-sdk/harness')`,
    `const tick = import(\`reeval/sandbox\`)`,
    `const built = import('ree' + 'val')`,
    `type T = typeof import('reeval/store/s3')`,
    `import f = require('reeval/testing')`,
    `export * from './mod.ts'`,
    `export * as Egress from './egress.ts'`,
    `export const g = 1, EgressPolicy = 2`,
    `export const { BrokerA, h: [GatewayB, ...SubstitutionC], i = 1 } = {} as any`,
    `export import GatewayAlias = Foo.Bar`,
    `// import { gone } from 'commented-out'`,
    `/* export * from 'also-commented-out' */`,
    `const s = "import { no } from 'in-a-string'"`,
    `export type AttemptOptions = {}`,
    `export type PlannedEgress = {}`,
    `export const brokerToken = 1`,
    `export { j as JudgeModel, type HarnessResult }`,
    `export function checkAgent() {}`,
    `export type Platform = string`,
    `export type PlanMode = 'plan'`,
    `export type PlanStep = {}`,
    `export type PlanUpdate = {}`,
    `export const planned = 1`,
    `export type Planner = {}`,
    `export const aiGatewayModel = 'x'`,
  ].join('\n')
  const outside = (s: string) => `${s} is outside src/: the package imports nothing of reeval's`
  const notDependency = (name: string) => `${name} isn't one of the package's dependencies`
  assert.deepEqual(
    loads(file, text).map((s) => [s, refusal(file, s)]),
    [
      ['../index.ts', undefined],
      ['../../../reeval/src/types.ts', outside('../../../reeval/src/types.ts')],
      ['reeval', notDependency('reeval')],
      ['reeval/view', notDependency('reeval')],
      ['reeval/judge', notDependency('reeval')],
      ['node:fs', undefined],
      ['@reeval/sandbox-docker', notDependency('@reeval/sandbox-docker')],
      ['after-a-regex-quote', notDependency('after-a-regex-quote')],
      ['reeval/harness', notDependency('reeval')],
      ['@ai-sdk/harness', notDependency('@ai-sdk/harness')],
      ['reeval/sandbox', notDependency('reeval')],
      [null, "a specifier computed at run time can't be checked"],
      ['reeval/store/s3', notDependency('reeval')],
      ['reeval/testing', notDependency('reeval')],
      ['./mod.ts', undefined],
      ['./egress.ts', undefined],
      ['reeval', notDependency('reeval')],
      ['../../../reeval/src/types.d.ts', outside('../../../reeval/src/types.d.ts')],
    ],
  )
  assert.deepEqual(exportedNames(file, text).filter(refusedName), [
    'Egress',
    'EgressPolicy',
    'BrokerA',
    'GatewayB',
    'SubstitutionC',
    'GatewayAlias',
    'AttemptOptions',
    'PlannedEgress',
    'brokerToken',
    'JudgeModel',
  ])
})
