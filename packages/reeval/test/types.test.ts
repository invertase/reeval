// The published types, as a project that imports `reeval` reads them: `test/types/` typechecks
// against dist/, where each `@ts-expect-error` is a pairing the compiler must refuse.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pkgRoot } from './helpers.ts'

const require = createRequire(import.meta.url)
const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc')

test('each matcher typechecks on the subjects it takes, and only those', () => {
  const r = spawnSync(process.execPath, [tsc, '-p', join(pkgRoot, 'test', 'types')], {
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
})
