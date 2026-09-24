import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { baseEnv, fakeConfig, pkgRoot, tempDir } from './helpers.ts'

const pnpm = (cwd: string, args: string[]) =>
  spawnSync('pnpm', args, { cwd, env: baseEnv, encoding: 'utf8', timeout: 120_000 })

const hasPnpm = pnpm(pkgRoot, ['--version']).status === 0

test('the packed package installs into a clean project and runs es', {
  skip: !hasPnpm && 'needs pnpm',
  timeout: 240_000,
}, async () => {
  const dir = tempDir('packed')
  const packed = pnpm(pkgRoot, ['pack', '--pack-destination', dir])
  assert.equal(packed.status, 0, packed.stdout + packed.stderr)
  const tarball = readdirSync(dir).find((f) => f.endsWith('.tgz'))
  assert.ok(tarball, packed.stdout)
  const listing = spawnSync('tar', ['tzf', join(dir, tarball)], { encoding: 'utf8' }).stdout
  assert.match(listing, /^package\/dist\/cli\.js$/m)
  assert.match(listing, /^package\/dist\/setup\.js$/m)
  assert.doesNotMatch(listing, /^package\/(src|test)\//m)

  const app = join(dir, 'app')
  await mkdir(join(app, 'evals'), { recursive: true })
  await writeFile(join(app, 'package.json'), '{ "name": "app", "private": true, "type": "module" }')
  await writeFile(join(app, 'es.config.ts'), fakeConfig())
  await writeFile(
    join(app, 'evals/hello.es.ts'),
    `import { evaluate, expect } from 'evalsuite'
evaluate('hello', async (t) => {
  await t.send('say hi')
  expect(await t.judge('Did it say hi?')).toPass()
})
`,
  )
  const added = pnpm(app, ['add', `../${tarball}`, '--prefer-offline'])
  assert.equal(added.status, 0, added.stdout + added.stderr)

  const es = (...args: string[]) =>
    spawnSync(join(app, 'node_modules/.bin/es'), args, {
      cwd: app,
      env: baseEnv,
      encoding: 'utf8',
      timeout: 60_000,
    })
  assert.equal(es('--version').stdout.trim(), JSON.parse(listingPackage(dir, tarball)).version)
  const run = es('run')
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /✓ evals\/hello\.es\.ts › hello/)
  assert.equal(es('show').status, 0)
})

function listingPackage(dir: string, tarball: string): string {
  return spawnSync('tar', ['xzf', join(dir, tarball), '-O', 'package/package.json'], {
    encoding: 'utf8',
  }).stdout
}
