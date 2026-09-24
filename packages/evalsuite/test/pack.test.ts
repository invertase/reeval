import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { baseEnv, fakeConfig, pkgRoot, tempDir } from './helpers.ts'

const sh = (cmd: string, cwd: string, args: string[], timeout = 120_000) =>
  spawnSync(cmd, args, { cwd, env: baseEnv, encoding: 'utf8', timeout })

const hasTools =
  sh('pnpm', pkgRoot, ['--version']).status === 0 &&
  sh('npm', pkgRoot, ['ping'], 15_000).status === 0
const hasDocker = sh('docker', pkgRoot, ['info']).status === 0

test('the packed packages install into a clean project and run es', {
  skip: !hasTools && 'needs pnpm, npm and the registry',
  timeout: 300_000,
}, async () => {
  const dir = tempDir('packed')
  // evalsuite depends on @evalsuite/sandbox-docker, so both tarballs go in, as from the registry.
  for (const pkg of ['evalsuite', 'sandbox-docker']) {
    const packed = sh('pnpm', join(pkgRoot, '..', pkg), ['pack', '--pack-destination', dir])
    assert.equal(packed.status, 0, packed.stdout + packed.stderr)
  }
  const tarballs = readdirSync(dir).filter((f) => f.endsWith('.tgz'))
  const tarball = tarballs.find((f) => f.startsWith('evalsuite-')) as string
  const docker = tarballs.find((f) => f.includes('sandbox-docker')) as string
  assert.ok(tarball && docker, tarballs.join(', '))
  const listing = sh('tar', dir, ['tzf', tarball]).stdout
  assert.match(listing, /^package\/dist\/cli\.js$/m)
  assert.match(listing, /^package\/dist\/setup\.js$/m)
  assert.doesNotMatch(listing, /^package\/(src|test)\//m)
  const dockerListing = sh('tar', dir, ['tzf', docker]).stdout
  assert.match(dockerListing, /^package\/docker\/Dockerfile$/m)
  assert.match(dockerListing, /^package\/dist\/index\.js$/m)

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
  const added = sh(
    'npm',
    app,
    ['install', '--no-audit', '--no-fund', '--prefer-offline', `../${tarball}`, `../${docker}`],
    240_000,
  )
  assert.equal(added.status, 0, added.stdout + added.stderr)

  const es = (...args: string[]) => sh(join(app, 'node_modules/.bin/es'), app, args, 60_000)
  assert.equal(es('--version').stdout.trim(), JSON.parse(listingPackage(dir, tarball)).version)
  assert.equal(es('image', 'build', '--help').status, 0)
  const run = es('run')
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /✓ evals\/hello\.es\.ts › hello/)
  assert.equal(es('show').status, 0)

  // `es image build` builds from the installed package's docker/ directory.
  const context = sh(process.execPath, app, [
    '-e',
    "import('@evalsuite/sandbox-docker').then((m) => console.log(m.DOCKER_CONTEXT))",
  ]).stdout.trim()
  assert.ok(context.startsWith(join(app, 'node_modules')), context)
  assert.ok(existsSync(join(context, 'Dockerfile')))
  if (hasDocker) {
    const tag = 'evalsuite-pack-smoke:test'
    const built = sh('docker', app, ['build', '--quiet', '--tag', tag, context], 240_000)
    assert.equal(built.status, 0, built.stderr)
    sh('docker', app, ['rmi', '-f', tag])
  }
})

function listingPackage(dir: string, tarball: string): string {
  return spawnSync('tar', ['xzf', join(dir, tarball), '-O', 'package/package.json'], {
    encoding: 'utf8',
  }).stdout
}
