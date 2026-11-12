import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
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

  test('reeval/view re-exports the same consumer runtime surface', async () => {
    const view = await loadExport('./view')
    const report = await loadExport('./view/report')
    for (const name of CONSUMER_RUNTIME) {
      assert.equal(typeof view[name], typeof report[name], name)
    }
  })
})
