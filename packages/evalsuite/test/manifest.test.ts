import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { baseEnv, pkgRoot, tempDir } from './helpers.ts'

const repoRoot = join(pkgRoot, '../..')
const workspacePackages = new Set(
  ['packages', 'examples'].flatMap((group) =>
    readdirSync(join(repoRoot, group)).map(
      (dir) => JSON.parse(readFileSync(join(repoRoot, group, dir, 'package.json'), 'utf8')).name,
    ),
  ),
)

const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundleDependencies',
  'bundledDependencies',
] as const

test('the packed manifest names nothing that only exists in this workspace', () => {
  const dir = tempDir('manifest')
  const packed = spawnSync('pnpm', ['pack', '--pack-destination', dir], {
    cwd: pkgRoot,
    env: baseEnv,
    encoding: 'utf8',
  })
  assert.equal(packed.status, 0, packed.stdout + packed.stderr)
  const tarball = readdirSync(dir).find((f) => f.endsWith('.tgz')) as string
  const read = spawnSync('tar', ['-xzOf', tarball, 'package/package.json'], {
    cwd: dir,
    encoding: 'utf8',
  })
  assert.equal(read.status, 0, read.stderr)
  const manifest = JSON.parse(read.stdout)

  assert.equal(manifest.name, '@invertase/foobar')
  assert.equal(manifest.devDependencies, undefined)
  assert.equal(manifest.scripts, undefined)
  assert.equal(manifest.packageManager, undefined)
  assert.equal(manifest.pnpm, undefined)
  for (const field of DEP_FIELDS) {
    const deps = manifest[field] ?? {}
    const names = Array.isArray(deps) ? deps : Object.keys(deps)
    for (const name of names) {
      assert.ok(!workspacePackages.has(name), `${field} names workspace package ${name}`)
      assert.ok(!name.startsWith('@evalsuite/'), `${field} names ${name}`)
    }
    if (!Array.isArray(deps)) {
      for (const [name, spec] of Object.entries(deps)) {
        assert.doesNotMatch(String(spec), /^(workspace|catalog|link|file):/, `${field}.${name}`)
      }
    }
  }
})
