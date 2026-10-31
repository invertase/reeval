// An eval file's declarations as data (src/declaration.ts): what evaluate and group record, and
// that the tree, through JSON and declared again, plans the same tests as the calls did.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
import { harnessId } from '../src/options.ts'
import { planEval } from '../src/plan-eval.ts'
import type { RunContext } from '../src/types.ts'
import { tempDir } from './helpers.ts'

function runIn(root: string): RunContext {
  const config = resolveConfig(
    {
      harnesses: [fakeHarness(), cursor({ model: 'composer-2.5' })],
      runs: 1,
    },
    root,
  )
  return { runId: 'r', stagingDir: root, config, tags: [], concurrency: 4, profile: null }
}

/** Collects `file` under `root` with `declare`, as a worker would. */
async function collected(root: string, declare: () => void) {
  const run = runIn(root)
  useEngine({
    registerTest,
    registerGroup,
    getRunContext: () => run,
    collectingFile,
    declareHarnesses: () => {},
  })
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
  group('outer', { tags: ['smoke'], harnesses: { only: 'fake' } }, () => {
    evaluate('a', { runs: 2 }, async () => {})
    group.skip('skipped', () => {
      evaluate('b', async () => {})
    })
    group('both', { harnesses: { add: cursor({ model: 'composer-2', id: 'fast' }) } }, () => {
      evaluate('c', { compare: { control: plain, variants: [skill] } }, async () => {})
    })
  })
  evaluate('d', { timeout: '2m', egress: 'deny-all', environments: skill }, async () => {})
  evaluate.each([{ n: 1 }, { n: 2 }])('case $n', async () => {})
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

/** A tree as another language writes it: host paths relative to the eval file, evals/x.eval.ts. */
function relativeTree(): DeclarationTree['children'] {
  const env = (name: string, spec: object) => ({
    kind: 'environment',
    name,
    layers: [{ name, spec }],
  })
  const docker = (dockerfile: string) => ({ kind: 'docker', dockerfile })
  const context = env('context', {
    files: { 'a.txt': { kind: 'file', path: './fixtures/a.txt' } },
    rules: { kind: 'file', path: '../RULES.md' },
    skills: [
      { kind: 'skill', source: 'local', path: './skills', placement: 'harness' },
      { kind: 'skill', source: 'npm', spec: '../pkg.tgz', path: 'skills', placement: 'harness' },
    ],
    workspace: { kind: 'git', repo: '../app', url: '../app' },
  })
  const eval_ = (name: string, options: object, extra: object = {}) => ({
    type: 'eval' as const,
    name,
    mode: 'run' as const,
    options,
    body: 'b1',
    source: { body: '0'.repeat(64) },
    ...extra,
  })
  return [
    {
      type: 'group',
      name: 'fake',
      mode: 'run',
      options: { harnesses: { only: 'fake' }, sandbox: { kind: 'fake', dir: './sandboxes' } },
      children: [eval_('context', { environments: context })],
    },
    eval_('compare', {
      compare: {
        control: env('plain', { sandbox: docker('./images/Dockerfile') }),
        variants: [env('built', { sandbox: docker('../docker/Dockerfile') })],
      },
    }),
    ...[0, 1].map((i) =>
      eval_(
        `case ${i}`,
        { sandbox: docker('images/Dockerfile') },
        {
          family: { name: 'case %#', case: i, cases: 2 },
        },
      ),
    ),
  ] as DeclarationTree['children']
}

/** A project with the Dockerfiles the relative tree names. */
function pathsProject(name: string): string {
  const root = tempDir(name)
  for (const dir of ['evals/images', 'docker']) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, 'Dockerfile'), 'FROM debian:bookworm-slim\n')
  }
  return root
}

/** Every host path a declared tree's options hold, by where it sits. */
function hostPaths(nodes: DeclarationTree['children'], into: Record<string, string> = {}) {
  const at = (value: unknown, path: string) => {
    if (typeof value !== 'object' || value === null) return
    const v = value as Record<string, unknown>
    if (v.kind === 'fake' && typeof v.dir === 'string') into[`${path}.dir`] = v.dir
    if (v.kind === 'docker' && typeof v.dockerfile === 'string')
      into[`${path}.dockerfile`] = v.dockerfile
    if (v.kind === 'file' && typeof v.path === 'string') into[`${path}.path`] = v.path
    if (v.source === 'local' && typeof v.path === 'string') into[`${path}.path`] = v.path
    if (v.source === 'npm' && typeof v.spec === 'string') into[`${path}.spec`] = v.spec
    if (v.kind === 'git' && typeof v.url === 'string') into[`${path}.url`] = v.url
    for (const [key, child] of Object.entries(v)) at(child, `${path}.${key}`)
  }
  for (const node of nodes) {
    if (node.type === 'todo') continue
    at(node.options, `${node.name}`)
    if (node.type === 'group') hostPaths(node.children, into)
  }
  return into
}

test("a tree's relative host paths resolve against the declaring file's directory", async () => {
  const root = pathsProject('tree-paths')
  const evals = join(root, 'evals')
  const { file } = await collected(root, () => declareTree(relativeTree(), () => async () => {}))
  const tree = JSON.parse(JSON.stringify(declaredTree(file))) as DeclarationTree
  assert.deepEqual(hostPaths(tree.children), {
    'fake.sandbox.dir': join(evals, 'sandboxes'),
    'context.environments.layers.0.spec.files.a.txt.path': join(evals, 'fixtures/a.txt'),
    'context.environments.layers.0.spec.rules.path': join(root, 'RULES.md'),
    'context.environments.layers.0.spec.skills.0.path': join(evals, 'skills'),
    'context.environments.layers.0.spec.skills.1.spec': join(root, 'pkg.tgz'),
    'context.environments.layers.0.spec.workspace.url': join(root, 'app'),
    'compare.compare.baseline.layers.0.spec.sandbox.dockerfile': join(evals, 'images/Dockerfile'),
    'compare.compare.variants.0.layers.0.spec.sandbox.dockerfile': join(root, 'docker/Dockerfile'),
    'case 0.sandbox.dockerfile': join(evals, 'images/Dockerfile'),
    'case 1.sandbox.dockerfile': join(evals, 'images/Dockerfile'),
  })
})

test('a tree with relative paths plans the same tests as with absolute ones', async () => {
  const root = pathsProject('tree-relative')
  const relative = await collected(root, () => declareTree(relativeTree(), () => async () => {}))
  const absolute = JSON.parse(JSON.stringify(declaredTree(relative.file))) as DeclarationTree
  const elsewhere = await collected(tempDir('tree-absolute'), () =>
    declareTree(absolute.children, () => async () => {}),
  )
  const order = (tests: typeof relative.tests) =>
    JSON.parse(
      JSON.stringify(tests, (key, value) =>
        key === 'order' && typeof value === 'number' ? 0 : value,
      ),
    )
  assert.equal(relative.tests.length, 9)
  assert.deepEqual(order(elsewhere.tests), order(relative.tests))
  const replayed = JSON.parse(JSON.stringify(declaredTree(elsewhere.file))) as DeclarationTree
  assert.deepEqual(hostPaths(replayed.children), hostPaths(absolute.children))
})

test("a tree's missing Dockerfile is refused at its absolute path, naming the field", async () => {
  const root = tempDir('tree-missing')
  const sandbox = { kind: 'docker', dockerfile: './Dockerfile' }
  const env = { kind: 'environment', name: 'e', layers: [{ name: 'e', spec: { sandbox } }] }
  const node = (options: object) =>
    [
      {
        type: 'eval',
        name: 'e',
        mode: 'run',
        options,
        body: 'b1',
        source: { body: '0'.repeat(64) },
      },
    ] as DeclarationTree['children']
  const full = join(root, 'evals', 'Dockerfile')
  for (const [options, field] of [
    [{ sandbox }, 'sandbox.dockerfile'],
    [{ environments: env }, 'environments.layers[0].spec.sandbox.dockerfile'],
    [
      { compare: { control: env, variants: [] } },
      'compare.control.layers[0].spec.sandbox.dockerfile',
    ],
  ] as const) {
    await assert.rejects(
      () => collected(root, () => declareTree(node(options), () => async () => {})),
      {
        name: 'UsageError',
        message: `${field} in evaluate("e"): ${full} doesn't exist. Paths are relative to the file that declares it.`,
      },
    )
  }
})

test('replaying a tree with compare: false is refused like evaluate', async () => {
  await assert.rejects(
    () =>
      collected(tempDir('false-compare'), () =>
        declareTree(
          [
            {
              type: 'eval',
              name: 'e',
              mode: 'run',
              options: { compare: false } as never,
              body: 'b1',
              source: { body: '0'.repeat(64) },
            },
          ],
          () => async () => {},
        ),
      ),
    /compare: false can't be set in evaluate\("e"\)/,
  )
})

test('a malformed tree is refused before anything is declared', async () => {
  const root = tempDir('malformed')
  const declared = await collected(root, () => {
    assert.throws(
      () =>
        declareTree(
          [
            {
              type: 'eval',
              name: 'a',
              mode: 'run',
              options: {},
              body: 'b1',
              source: { body: '0'.repeat(64) },
            },
            { type: 'eval', name: 'b', mode: 'run', options: {}, bdy: 'b2' } as never,
          ],
          () => async () => {},
        ),
      /^UsageError: The declaration tree's children\[1\] has an unknown key "bdy". Did you mean "body"\?$/,
    )
  })
  assert.deepEqual(declared.tests, [])
})

test('planEval is pure: the same declaration and context give the same tests, gate as data', () => {
  const run = runIn(tempDir('pure'))
  const ctx = { ...run, file: join(run.config.root, 'evals/p.eval.ts'), order: 3 }
  const declaration = { name: 'p', mode: 'run' as const, groups: [], options: { runs: 2 } }
  const { tests: once, harnesses } = planEval(declaration, ctx)
  assert.deepEqual(
    JSON.parse(JSON.stringify(planEval(declaration, ctx).tests)),
    JSON.parse(JSON.stringify(once)),
  )
  assert.equal(once?.length, 4)
  assert.deepEqual(harnesses, run.config.harness.map(harnessId))
  assert.deepEqual(once?.[0]?.gate, {
    limits: { attempts: 4 },
    rank: { eval: 'evals/p.eval.ts › p', file: 'evals/p.eval.ts', order: 3, n: 1, cell: 0 },
  })
  assert.deepEqual(
    planEval({ ...declaration, options: { tags: ['x'] } }, { ...ctx, tags: ['y'] }),
    { tests: null, harnesses },
    'an eval the tags leave out still names its harnesses',
  )
})

test("planEval holds the engine's backstop to the longest timer Node can set", () => {
  const run = runIn(tempDir('backstop'))
  const ctx = { ...run, file: join(run.config.root, 'evals/p.eval.ts'), order: 0 }
  const environment = defineEnvironment('slow', { setup: [{ run: 'ls', timeout: '30m' }] })
  const plan = (timeout: string) =>
    planEval(
      { name: 'p', mode: 'run', groups: [], options: { timeout, environments: environment } },
      ctx,
    ).tests?.[0]?.timeout
  // 596h and the setup step each fit a timer; with the harness's start allowance they don't.
  assert.equal(plan('596h'), 2 ** 31 - 1)
  assert.equal(plan('1h'), 3_600_000 + 1_800_000 + 2 * 90_000 + 5_000)
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
  const family = { name: 'case', case: 0.5, cases: 2 }
  const fractional = {
    type: 'eval',
    name: 'e',
    mode: 'run',
    options: {},
    body: 'b',
    source: { body: '0'.repeat(64) },
    family,
  }
  assert.deepEqual(validate(schema('declaration'), { children: [fractional] }), [
    'children[0].family.case: expected a whole number, got 0.5',
  ])
})
