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
import { buildMatrix, renderMarkdown, type Sources } from './support/matrix.ts'

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
      path === 'reeval/test/unit.test.ts'
        ? "// covers a comment\nconst label = 'a helper string'\ntest('parses a thing', () => {})"
        : null,
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
    tests: ['reeval/test/unit.test.ts › parses a thing'],
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
      'inventory y: nothing covers it on any tier. Add a fixture, plan case or test, or mark it a known gap with the reason',
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

  test('a fixture or plan case that covers no feature fails', () => {
    const m = buildMatrix([feature({ fixtures: ['skills/a'] })], sources)
    assert.deepEqual(m.problems, [
      'fixture skills/b covers no feature: add it to an entry in inventory.ts',
      'plan case matrix/default covers no feature: add it to an entry in inventory.ts',
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
      'inventory y: "rules read" isn\'t "contract › <behaviour>", "e2e › <title>", "questions › <title>" or "remarks › <title>"',
      'contract behaviour "clean teardown" covers no feature: add it to an entry in inventory.ts',
    ])
  })

  test('names that do not exist fail', () => {
    const m = buildMatrix(
      [
        everything,
        feature({
          id: 'y',
          fixtures: ['skills/nope'],
          plan: ['matrix/nope'],
          tests: [
            'reeval/test/unit.test.ts › a test that is not there',
            'reeval/test/unit.test.ts › covers a comment',
            'reeval/test/unit.test.ts › a helper string',
            'reeval/test/nope.test.ts › anything',
            'no title',
          ],
        }),
        feature({ id: 'y', tests: ['reeval/test/unit.test.ts › parses a thing'] }),
      ],
      sources,
    )
    assert.deepEqual(m.problems, [
      "inventory y: fixture skills/nope isn't in features.test.ts",
      "inventory y: plan case matrix/nope isn't in plan.test.ts",
      'inventory y: reeval/test/unit.test.ts has no test "a test that is not there"',
      'inventory y: reeval/test/unit.test.ts has no test "covers a comment"',
      'inventory y: reeval/test/unit.test.ts has no test "a helper string"',
      "inventory y: reeval/test/nope.test.ts doesn't exist",
      'inventory y: "no title" isn\'t "<file> › <title>"',
      'inventory y: nothing covers it on any tier. Add a fixture, plan case or test, or mark it a known gap with the reason',
      'inventory y: the id is used twice',
    ])
  })
})
