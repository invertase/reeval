import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { pkgRoot } from './helpers.ts'

const require = createRequire(import.meta.url)
const pkg = require(join(pkgRoot, 'package.json')) as {
  name: string
  version: string
  exports: Record<string, string | { types?: string; default: string }>
}

async function loadExport(subpath: string): Promise<Record<string, unknown>> {
  const target = pkg.exports[subpath]
  assert.ok(target && typeof target === 'object', `${subpath} is a package export`)
  const file = join(pkgRoot, target.default)
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>
}

/** Symbols reeval-components and check-text must be able to import from the package. */
const CONSUMER_RUNTIME = [
  'buildRunReport',
  'runReportSchema',
  'blockMarkdown',
  'runReportMarkdown',
  'FORBIDDEN_OUTPUT',
  'tokensText',
  'tokensFigure',
  'durationFigure',
  'usdFigure',
  'countFigure',
  'countOf',
  'rateOf',
  'medianWithDelta',
  'pctDelta',
  'ptsDelta',
] as const

/** On `reeval/view/report` only, so the `reeval/view` root stays free of zod. */
const SCHEMA_EXPORTS: readonly string[] = [
  'runReportSchema',
  'attemptRefSchema',
  'countSchema',
  'deltaSchema',
  'figureSchema',
  'headlinePrimarySchema',
  'intervalSchema',
  'rateSchema',
  'reportClaimSchema',
  'spreadSchema',
]

describe('reeval/view/report public export', () => {
  test('package.json exposes ./view/report beside ./view', () => {
    assert.equal(pkg.name, 'reeval')
    assert.ok(pkg.exports['./view'], './view')
    assert.ok(pkg.exports['./view/report'], './view/report')
    const report = pkg.exports['./view/report']
    assert.ok(typeof report === 'object')
    assert.equal(report.default, './dist/view/report/index.js')
    assert.equal(report.types, './dist/view/report/index.d.ts')
  })

  test('reeval/view/report ships the consumer runtime surface', async () => {
    const mod = await loadExport('./view/report')
    for (const name of CONSUMER_RUNTIME) {
      assert.notEqual(mod[name], undefined, name)
    }
    assert.ok(Array.isArray(mod.FORBIDDEN_OUTPUT))
    assert.equal(typeof mod.buildRunReport, 'function')
    assert.equal(typeof mod.runReportMarkdown, 'function')
    assert.equal(typeof mod.blockMarkdown, 'object')
    assert.ok(
      mod.blockMarkdown &&
        typeof (mod.blockMarkdown as { runHeader?: unknown }).runHeader === 'function',
    )
    assert.ok(mod.runReportSchema && typeof mod.runReportSchema === 'object')
  })

  test('reeval/view re-exports the zod-free surface, not the schema', async () => {
    const view = await loadExport('./view')
    const report = await loadExport('./view/report')
    for (const name of CONSUMER_RUNTIME.filter((n) => !SCHEMA_EXPORTS.includes(n))) {
      assert.equal(typeof view[name], typeof report[name], name)
    }
    for (const name of SCHEMA_EXPORTS) {
      assert.notEqual(report[name], undefined, `reeval/view/report exports ${name}`)
      assert.equal(view[name], undefined, `reeval/view must not export ${name}`)
    }
  })

  test("reeval/view's built modules never import zod", () => {
    const target = pkg.exports['./view']
    assert.ok(target && typeof target === 'object')
    const seen = new Set<string>()
    const importers: string[] = []
    const visit = (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      const code = readFileSync(file, 'utf8')
      if (/\bfrom\s*["']zod["']|import\(\s*["']zod["']\s*\)/.test(code)) importers.push(file)
      for (const [, spec] of code.matchAll(/\bfrom\s*["'](\.{1,2}\/[^"']+)["']/g)) {
        visit(resolve(dirname(file), spec as string))
      }
    }
    visit(join(pkgRoot, target.default))
    assert.deepEqual(importers, [], 'modules reachable from reeval/view that import zod')
  })
})
