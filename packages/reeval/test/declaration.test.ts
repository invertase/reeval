// An eval file's declarations as data (src/declaration.ts): what evaluate and group record, and
// that the tree, through JSON and declared again, plans the same tests as the calls did.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { validate } from '../scripts/schema/validate.ts'
import { resolveConfig } from '../src/config.ts'
import type { DeclarationTree } from '../src/declaration.ts'
import { collect, collectingFile, registerGroup, registerTest } from '../src/engine/collector.ts'
import { useEngine } from '../src/engine/runtime.ts'
import { defineEnvironment } from '../src/environment.ts'
import { declaredBody, declaredTree, declareTree, evaluate, group } from '../src/evaluate.ts'
import { cursor, fakeHarness } from '../src/harness.ts'
import { planEval } from '../src/plan-eval.ts'
import type { RunContext } from '../src/types.ts'
import { tempDir } from './helpers.ts'

function runIn(root: string): RunContext {
  const config = resolveConfig(
    {
      harness: [fakeHarness(), cursor({ model: 'composer-2.5' })],
      runs: 1,
    },
    root,
  )
  return { runId: 'r', stagingDir: root, config, tags: [], concurrency: 4, profile: null }
}

/** Collects `file` under `root` with `declare`, as a worker would. */
async function collected(root: string, declare: () => void) {
  const run = runIn(root)
  useEngine({ registerTest, registerGroup, getRunContext: () => run, collectingFile })
  const file = join(root, 'evals/x.eval.ts')
  const tests = await collect(file, async () => declare())
  return {
    file,
    tests: tests.map(({ index, name, groups, mode, options }) => ({
      index,
      name,
      groups,
      mode,
      options,
    })),
  }
}

const plain = defineEnvironment('plain', {})
const skill = defineEnvironment('skill', { rules: 'Use the house style.' })

function declarations() {
  group('outer', { tags: ['smoke'], harness: { only: 'fake' } }, () => {
    evaluate('a', { runs: 2 }, async () => {})
    group.skip('skipped', () => {
      evaluate('b', async () => {})
    })
    group('both', { harness: { add: cursor({ model: 'composer-2', id: 'fast' }) } }, () => {
      evaluate('c', { compare: { baseline: plain, variants: [skill] } }, async () => {})
    })
  })
  evaluate('d', { timeout: '2m', egress: 'deny-all', environment: skill }, async () => {})
  evaluate.for([{ n: 1 }, { n: 2 }])('case $n', async () => {})
  evaluate.todo('later')
  group.todo('also later')
}

test('evaluate and group record the tree they declare, and each body by id', async () => {
  const { file } = await collected(tempDir('declared'), declarations)
  const tree = declaredTree(file)
  assert.ok(tree)
  const shape = (nodes: DeclarationTree['children']): unknown[] =>
    nodes.map((n) =>
      n.type === 'todo'
        ? `todo ${n.name}`
        : n.type === 'eval'
          ? `${n.mode} ${n.name} ${n.body}`
          : { [`${n.mode} ${n.name}`]: shape(n.children) },
    )
  const data = JSON.parse(JSON.stringify(tree)) as DeclarationTree
  assert.deepEqual(shape(data.children), [
    {
      'run outer': ['run a b4', { 'skip skipped': ['run b b5'] }, { 'run both': ['run c b6'] }],
    },
    'run d b1',
    'run case 1 b2',
    'run case 2 b3',
    'todo later',
    'todo also later',
  ])
  for (const node of data.children)
    if (node.type === 'eval') assert.equal(typeof declaredBody(node.body), 'function')
})

test('a tree through JSON, declared again, plans the same tests as the calls', async () => {
  const calls = await collected(tempDir('calls'), declarations)
  const tree = JSON.parse(JSON.stringify(declaredTree(calls.file))) as DeclarationTree
  const replayed = await collected(tempDir('tree'), () =>
    declareTree(tree.children, (id) => declaredBody(id) as never),
  )
  // The scheduler's tie-break counts the evals this process planned, across files.
  const plain = (tests: typeof calls.tests) => {
    const first = Math.min(...tests.map((t) => t.options.gate?.rank.order ?? Infinity))
    return JSON.parse(
      JSON.stringify(tests, (key, value) =>
        key === 'order' && typeof value === 'number' ? value - first : value,
      ),
    )
  }
  assert.ok(calls.tests.length > 8, `${calls.tests.length} tests`)
  assert.deepEqual(plain(replayed.tests), plain(calls.tests))
  assert.deepEqual(
    calls.tests.map((t) => `${t.mode} ${[...t.groups, t.name].join(' › ')}`).slice(0, 4),
    [
      'run outer › a [fake/-/docker#1]',
      'run outer › a [fake/-/docker#2]',
      'skip outer › skipped › b [fake/-/docker#1]',
      'run outer › both › c [fake/plain/docker#1]',
    ],
  )
})

test('planEval is pure: the same declaration and context give the same tests, gate as data', () => {
  const run = runIn(tempDir('pure'))
  const ctx = { ...run, file: join(run.config.root, 'evals/p.eval.ts'), order: 3 }
  const declaration = { name: 'p', mode: 'run' as const, groups: [], options: { runs: 2 } }
  const once = planEval(declaration, ctx)
  assert.deepEqual(
    JSON.parse(JSON.stringify(planEval(declaration, ctx))),
    JSON.parse(JSON.stringify(once)),
  )
  assert.equal(once?.length, 4)
  assert.deepEqual(once?.[0]?.gate, {
    limits: { attempts: 4 },
    rank: { eval: 'evals/p.eval.ts › p', file: 'evals/p.eval.ts', order: 3, n: 1, cell: 0 },
  })
  assert.equal(
    planEval({ ...declaration, options: { tags: ['x'] } }, { ...ctx, tags: ['y'] }),
    null,
  )
})

test('the tree and the collected tests fit their JSON Schemas in schema/plan/', async () => {
  const schema = (name: string) =>
    JSON.parse(readFileSync(new URL(`../schema/plan/${name}.schema.json`, import.meta.url), 'utf8'))
  const { file, tests } = await collected(tempDir('schemas'), declarations)
  const tree = JSON.parse(JSON.stringify(declaredTree(file)))
  assert.deepEqual(validate(schema('declaration'), tree), [])
  const wire = tests.map(({ index, name, groups, mode, options }) => ({
    index,
    name,
    groups,
    mode,
    ...(options.attempt ? { attempt: options.attempt } : {}),
  }))
  for (const test of JSON.parse(JSON.stringify(wire)))
    assert.deepEqual(validate(schema('wire-test'), test), [], test.name)
  // The canary: a tree the schema rules out.
  assert.notDeepEqual(validate(schema('declaration'), { children: [{ type: 'eval' }] }), [])
})
