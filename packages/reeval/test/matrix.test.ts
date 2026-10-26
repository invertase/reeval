// The feature × tier matrix (test/features/inventory.ts, rendered to test/features/COVERAGE.md).
// It fails when a feature has nothing on any tier and isn't a known gap with a reason, when a
// fixture or plan case covers no feature, and when COVERAGE.md is stale.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { InventoryFeature } from './features/inventory.ts'
import { pkgRoot } from './helpers.ts'
import {
  buildMatrix,
  checkEvalOptionCoverage,
  renderMarkdown,
  type Sources,
} from './support/matrix.ts'

type Report = { problems: string[]; markdown: string; current: boolean }

const report = (): Report =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        '--import',
        pathToFileURL(join(pkgRoot, 'test/support/tables-only.mjs')).href,
        join(pkgRoot, 'test/support/feature-matrix.ts'),
        '--json',
      ],
      { encoding: 'utf8' },
    ),
  )

describe('the feature matrix', () => {
  const { problems, current } = report()

  test('every feature is covered on some tier or a known gap; every fixture and plan case covers one', () => {
    assert.deepEqual(problems, [])
  })

  test('COVERAGE.md is current', () => {
    assert.ok(current, 'test/features/COVERAGE.md is stale: run pnpm features:matrix --write')
  })
})

describe('the matrix check (twins: it can fail)', () => {
  const sources: Sources = {
    fixtures: [
      { dir: 'skills/a', tiers: ['fake', 'docker'], canary: true },
      { dir: 'skills/b', tiers: ['fake'], canary: false },
    ],
    planCases: ['matrix/default'],
    contract: [],
    testSource: (path) =>
      path === 'reeval/test/unit.test.ts' ? "test('parses a thing', () => {})" : null,
    evalOptionKeys: ['harness'],
    evalOptionSpecs: [{ key: 'harness', featureId: 'x', plan: true }],
    refusalText: 'harness in evals/a.eval.ts',
  }
  const feature = (f: Partial<InventoryFeature>): InventoryFeature => ({
    id: 'x',
    area: 'Environments',
    name: 'X',
    ...f,
  })
  const everything = feature({
    fixtures: ['skills/a', 'skills/b'],
    plan: ['matrix/default'],
    unit: ['reeval/test/unit.test.ts'],
  })

  test('a fully covered inventory has no problems, and each tier counts what covers it', () => {
    const m = buildMatrix([everything], sources)
    assert.deepEqual(m.problems, [])
    assert.deepEqual(m.rows[0]?.cells, {
      unit: { count: 1, canaries: 0 },
      plan: { count: 1, canaries: 0 },
      fake: { count: 2, canaries: 1 },
      docker: { count: 1, canaries: 1 },
      podman: { count: 0, canaries: 0 },
      real: { count: 0, canaries: 0 },
    })
    assert.match(
      renderMarkdown(m),
      /\| X \| ✓ 1 \| ✓ 1 \| ◐ 2 \(1 without a canary\) \| ● 1 \| — \| — \|/,
    )
  })

  test('a feature with nothing on any tier fails, unless it is a known gap with a reason', () => {
    const bare = buildMatrix([everything, feature({ id: 'y' })], sources).problems
    assert.deepEqual(bare, [
      'inventory y: nothing covers it on any tier. Add a fixture, plan case or test file, or mark it a known gap with the reason',
    ])
    const gap = buildMatrix([everything, feature({ id: 'y', gap: 'needs a registry' })], sources)
    assert.deepEqual(gap.problems, [])
    assert.match(renderMarkdown(gap), /- \*\*X\*\* \(`y`\): needs a registry/)
    const blank = buildMatrix([everything, feature({ id: 'y', gap: ' ' })], sources).problems
    assert.deepEqual(blank, ['inventory y: a known gap needs its reason'])
  })

  test('a gap that is covered now fails, so the list stays honest', () => {
    const m = buildMatrix([{ ...everything, gap: 'none yet' }], sources)
    assert.deepEqual(m.problems, [
      "inventory x: it's covered now, so it's no longer a gap: remove its gap",
    ])
  })

  test('a parameterised fixture counts a row per harness; its directory names them all', () => {
    const rows = {
      ...sources,
      fixtures: [
        ...sources.fixtures,
        { dir: 'harness/rules:pi', of: 'harness/rules', tiers: ['fake'], canary: true },
        { dir: 'harness/rules:codex', of: 'harness/rules', tiers: ['fake'], canary: true },
      ],
    }
    const m = buildMatrix(
      [
        everything,
        feature({ id: 'y', fixtures: ['harness/rules'] }),
        feature({ id: 'z', fixtures: ['harness/rules:pi'] }),
      ],
      rows,
    )
    assert.deepEqual(m.problems, [])
    assert.deepEqual(m.rows[1]?.cells.fake, { count: 2, canaries: 2 })
    assert.deepEqual(m.rows[2]?.cells.fake, { count: 1, canaries: 1 })
    const unclaimed = buildMatrix(
      [everything, feature({ id: 'z', fixtures: ['harness/rules:pi'] })],
      rows,
    )
    assert.deepEqual(unclaimed.problems, [
      'fixture harness/rules:codex covers no feature: add it to an entry in inventory.ts',
    ])
  })

  test('a fixture or plan case that covers no feature fails', () => {
    const m = buildMatrix([feature({ fixtures: ['skills/a'] })], sources)
    assert.deepEqual(m.problems, [
      'fixture skills/b covers no feature: add it to an entry in inventory.ts',
      'plan case matrix/default covers no feature: add it to an entry in inventory.ts',
      'eval option "harness": changes reeval run --dry-run output, so inventory x needs a plan case under test/plan/, not a feature fixture (see test/features/README.md#which-tier)',
    ])
  })

  test('real-suite checks count on the real tier; a behaviour no feature names fails', () => {
    const real = {
      ...sources,
      contract: [
        { name: 'rules read', canary: true },
        { name: 'clean teardown', canary: false },
      ],
      testSource: (path: string) =>
        path === 'reeval/test/e2e-real.test.ts'
          ? "test('reeval query: every view answers', () => {})"
          : path === 'reeval/test/questions-real.test.ts'
            ? "test('a real model votes in both orders', () => {})"
            : sources.testSource(path),
    }
    const m = buildMatrix(
      [
        everything,
        feature({
          id: 'y',
          real: [
            'contract › rules read',
            'contract › clean teardown',
            'e2e › reeval query',
            'questions › a real model votes',
          ],
        }),
      ],
      real,
    )
    assert.deepEqual(m.problems, [])
    assert.deepEqual(m.rows[1]?.cells.real, { count: 4, canaries: 1 })
    const unclaimed = buildMatrix(
      [
        everything,
        feature({
          id: 'y',
          real: ['contract › rules read', 'contract › nope', 'e2e › nope', 'rules read'],
        }),
      ],
      real,
    )
    assert.deepEqual(unclaimed.problems, [
      'inventory y: contract.test.ts has no behaviour "nope"',
      'inventory y: e2e-real.test.ts has no test "nope"',
      'inventory y: "rules read" isn\'t "contract › <behaviour>", "e2e › <title>", "questions › <title>" or "openrouter › <title>"',
      'contract behaviour "clean teardown" covers no feature: add it to an entry in inventory.ts',
    ])
  })

  test('eval option coverage fails when a key, plan case or refusal row is missing', () => {
    assert.deepEqual(
      checkEvalOptionCoverage([], {
        evalOptionKeys: ['harness', 'runs'],
        evalOptionSpecs: [{ key: 'harness', featureId: 'matrix.harness-runs', plan: true }],
        refusalText: '',
      }),
      [
        'eval option "runs" has no entry in test/features/eval-options.ts: add one naming its inventory feature; when reeval run --dry-run output changes, set plan: true and add a case under test/plan/',
        'eval option "harness": inventory feature matrix.harness-runs doesn\'t exist',
      ],
    )
    assert.deepEqual(
      checkEvalOptionCoverage([feature({ id: 'x' })], {
        evalOptionKeys: ['harness'],
        evalOptionSpecs: [
          { key: 'harness', featureId: 'x', plan: true, refusals: true },
          { key: 'harness', featureId: 'x' },
        ],
        refusalText: '',
      }),
      [
        'eval option "harness": changes reeval run --dry-run output, so inventory x needs a plan case under test/plan/, not a feature fixture (see test/features/README.md#which-tier)',
        'eval option "harness": add refusal rows in test/refusals/ for inventory x (REEVAL_UPDATE_SNAPSHOTS=1 pnpm --filter reeval test test/refusals.test.ts)',
        'eval option "harness" is listed twice in eval-options.ts',
      ],
    )
  })

  test('names that do not exist fail', () => {
    const m = buildMatrix(
      [
        everything,
        feature({
          id: 'y',
          fixtures: ['skills/nope'],
          plan: ['matrix/nope'],
          unit: ['reeval/test/nope.test.ts', 'reeval/test/unit.test.ts › a title'],
        }),
        feature({ id: 'y', unit: ['reeval/test/unit.test.ts'] }),
      ],
      sources,
    )
    assert.deepEqual(m.problems, [
      "inventory y: fixture skills/nope isn't in features.test.ts",
      "inventory y: plan case matrix/nope isn't in plan.test.ts",
      "inventory y: reeval/test/nope.test.ts doesn't exist",
      'inventory y: "reeval/test/unit.test.ts › a title" isn\'t a test file',
      'inventory y: nothing covers it on any tier. Add a fixture, plan case or test file, or mark it a known gap with the reason',
      'inventory y: the id is used twice',
    ])
  })
})
