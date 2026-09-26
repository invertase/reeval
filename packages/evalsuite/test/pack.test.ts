import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { VERSION } from '@evalsuite/harness-antigravity'
import { baseEnv, fakeConfig, pkgRoot, readRun, tempDir } from './helpers.ts'

const sh = (cmd: string, cwd: string, args: string[], timeout = 120_000) =>
  spawnSync(cmd, args, { cwd, env: baseEnv, encoding: 'utf8', timeout })

const hasTools =
  sh('pnpm', pkgRoot, ['--version']).status === 0 &&
  sh('npm', pkgRoot, ['ping'], 15_000).status === 0
const hasDocker = sh('docker', pkgRoot, ['info']).status === 0

test('the packed package installs into a clean project and runs es', {
  skip: !hasTools && 'needs pnpm, npm and the registry',
  timeout: 300_000,
}, async () => {
  const dir = tempDir('packed')
  const packed = sh('pnpm', pkgRoot, ['pack', '--pack-destination', dir])
  assert.equal(packed.status, 0, packed.stdout + packed.stderr)
  const tarball = readdirSync(dir).find((f) => f.endsWith('.tgz')) as string
  assert.ok(tarball, readdirSync(dir).join(', '))
  const listing = sh('tar', dir, ['tzf', tarball]).stdout
  assert.match(listing, /^package\/LICENSE$/m)
  assert.match(listing, /^package\/dist\/cli\.js$/m)
  assert.match(listing, /^package\/dist\/setup\.js$/m)
  assert.match(listing, /^package\/dist\/studio-app\/index\.html$/m)
  assert.match(listing, /^package\/dist\/vendor\/sandbox-docker\/docker\/Dockerfile$/m)
  assert.match(listing, /^package\/dist\/vendor\/sandbox-docker\/dist\/index\.js$/m)
  assert.match(listing, /^package\/dist\/vendor\/harness-antigravity\/dist\/index\.js$/m)
  assert.match(listing, /^package\/dist\/vendor\/harness-cursor-sdk\/dist\/index\.js$/m)
  assert.match(listing, /^package\/dist\/vendor\/harness-opencode\/dist\/index\.js$/m)
  assert.match(listing, /^package\/dist\/vendor\/harness-goose\/dist\/index\.js$/m)
  assert.match(listing, /^package\/dist\/vendor\/harness-pi\/dist\/index\.js$/m)
  assert.match(listing, /^package\/dist\/vendor\/harness-pi\/assets\/pnpm-lock\.yaml$/m)
  assert.doesNotMatch(listing, /^package\/(src|test)\//m)

  // sandbox-docker and harness-antigravity are vendored into dist, so nothing in the manifest
  // points at the workspace.
  const manifest = JSON.parse(listingPackage(dir, tarball))
  const pkg = manifest.name as string
  assert.equal(manifest.license, 'Apache-2.0')
  assert.doesNotMatch(JSON.stringify(manifest), /workspace:/)
  assert.ok(!Object.keys(manifest.dependencies).some((d) => d.startsWith('@evalsuite/')))

  const app = join(dir, 'app')
  await mkdir(join(app, 'evals'), { recursive: true })
  await writeFile(join(app, 'package.json'), '{ "name": "app", "private": true, "type": "module" }')
  await writeFile(join(app, 'es.config.ts'), fakeConfig().replaceAll("'evalsuite", `'${pkg}`))
  await writeFile(
    join(app, 'evals/hello.es.ts'),
    `import { evaluate, expect } from '${pkg}'
evaluate('hello', async (t) => {
  await t.send('say hi')
  expect(await t.judge('Did it say hi?')).toPass()
})
`,
  )
  // --prefer-online: a stale cached packument misses versions published since, but tarballs
  // still come from the cache.
  const added = sh(
    'npm',
    app,
    ['install', '--no-audit', '--no-fund', '--prefer-online', `../${tarball}`],
    240_000,
  )
  assert.equal(added.status, 0, added.stdout + added.stderr)

  const es = (...args: string[]) => sh(join(app, 'node_modules/.bin/es'), app, args, 60_000)
  assert.equal(es('--version').stdout.trim(), manifest.version)
  assert.equal(es('image', 'build', '--help').status, 0)
  const run = es('run')
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /✓ evals\/hello\.es\.ts › hello/)
  assert.equal(es('show').status, 0)
  // Adapters the package vendors can't be resolved by name, but the run still records them.
  assert.equal(readRun(app).run.stack.packages['@evalsuite/harness-antigravity'], VERSION)

  // `es image build` builds from the vendored docker/ directory inside the installed package.
  const [context, label]: string[] = JSON.parse(
    sh(process.execPath, app, [
      '-e',
      `import('./node_modules/${pkg}/dist/vendor/sandbox-docker/dist/index.js').then((m) => console.log(JSON.stringify([m.DOCKER_CONTEXT, m.harnessLabel('antigravity')])))`,
    ]).stdout,
  )
  assert.equal(label, `@evalsuite/harness-antigravity@${VERSION}`)
  assert.ok(context.startsWith(join(app, 'node_modules')), context)
  assert.ok(existsSync(join(context, 'Dockerfile')))
  // The vendored Antigravity adapter loads with the installed package's dependencies alone.
  const adapter = sh(process.execPath, app, [
    '-e',
    `import('./node_modules/${pkg}/dist/vendor/harness-antigravity/dist/index.js').then((m) => console.log(m.createAntigravity().harnessId))`,
  ])
  assert.equal(adapter.stdout.trim(), 'antigravity', adapter.stderr)
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
