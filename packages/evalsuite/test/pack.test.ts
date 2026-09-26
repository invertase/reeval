import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { test } from 'node:test'
import { VERSION } from '@evalsuite/harness-antigravity'
import { VERSION as CURSOR_VERSION } from '@evalsuite/harness-cursor-sdk'
import { baseEnv, fakeConfig, pkgRoot, readRun, tempDir } from './helpers.ts'

const sh = (cmd: string, cwd: string, args: string[], timeout = 120_000) =>
  spawnSync(cmd, args, { cwd, env: baseEnv, encoding: 'utf8', timeout })

const hasTools =
  sh('pnpm', pkgRoot, ['--version']).status === 0 &&
  sh('npm', pkgRoot, ['ping'], 15_000).status === 0
const hasDocker = sh('docker', pkgRoot, ['info']).status === 0

test('the packed package installs into a clean project and runs es', {
  skip: !hasTools && 'needs pnpm, npm and the registry',
  timeout: 900_000,
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
  assert.match(listing, /^package\/dist\/worker-signals\.js$/m)
  for (const entry of ['index', 'harness', 'sandbox', 'judge', 'view/index']) {
    assert.match(listing, new RegExp(`^package/dist/${entry}\\.js$`, 'm'))
    assert.match(listing, new RegExp(`^package/dist/${entry}\\.d\\.ts$`, 'm'))
  }
  // The bundled packages' other files, beside dist/ as in their own packages.
  assert.match(listing, /^package\/docker\/Dockerfile$/m)
  assert.match(listing, /^package\/assets\/pnpm-lock\.yaml$/m)
  assert.doesNotMatch(listing, /^package\/(src|test)\//m)

  // The @evalsuite/* packages are bundled into dist, so nothing in the manifest points at the
  // workspace.
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
  // Adapters the package bundles can't be resolved by name, but the run still records them.
  assert.equal(readRun(app).run.stack.packages['@evalsuite/harness-antigravity'], VERSION)

  // Nothing that ships imports an @evalsuite/* package, and every chunk loads with the installed
  // package's dependencies alone. cli, setup and worker-signals run on import, and so do the
  // chunks only the CLI reaches, which import cli.js.
  const dist = join(app, 'node_modules', pkg, 'dist')
  const shipped = readdirSync(dist, { recursive: true, encoding: 'utf8' })
  const code = shipped.filter((f) => /\.(js|d\.ts)$/.test(f) && !f.startsWith('studio-app/'))
  const source = (file: string) => readFileSync(join(dist, file), 'utf8')
  for (const file of code)
    assert.doesNotMatch(source(file), /(?:\bfrom|\bimport)\s*\(?\s*['"]@evalsuite\//, file)
  const imports = (file: string) =>
    [...source(file).matchAll(/\bfrom\s*"(\.\.?\/[^"]+)"/g)].map((m) =>
      posix.join(posix.dirname(file), m[1] as string),
    )
  const runsOnImport = (file: string, seen = new Set<string>()): boolean =>
    ['cli.js', 'setup.js', 'worker-signals.js'].includes(file) ||
    imports(file).some((f) => !seen.has(f) && seen.add(f) && runsOnImport(f, seen))
  const chunks = code.filter((f) => f.endsWith('.js') && !runsOnImport(f))
  assert.ok(chunks.includes('index.js') && chunks.length > 10, chunks.join(', '))
  const loaded = sh(process.execPath, app, [
    '--input-type=module',
    '-e',
    `for (const f of ${JSON.stringify(chunks)}) await import('./node_modules/${pkg}/dist/' + f)`,
  ])
  assert.equal(loaded.status, 0, loaded.stderr)

  if (hasDocker) {
    // `es image build` builds Cursor's image from the docker/ directory in the installed package.
    await writeFile(
      join(app, 'es.cursor.config.ts'),
      `import { defineConfig } from '${pkg}'
import { cursor } from '${pkg}/harness'
import { docker } from '${pkg}/sandbox'
export default defineConfig({ harness: cursor({ model: 'composer-2.5' }), sandbox: docker() })
`,
    )
    const built = sh(
      join(app, 'node_modules/.bin/es'),
      app,
      ['image', 'build', '--config', 'es.cursor.config.ts'],
      600_000,
    )
    assert.equal(built.status, 0, built.stdout + built.stderr)
    const label = sh('docker', app, [
      'image',
      'inspect',
      '--format',
      '{{ index .Config.Labels "dev.evalsuite.harness" }}',
      `evalsuite-sandbox:cursor-${CURSOR_VERSION}`,
    ])
    assert.equal(label.stdout.trim(), `@evalsuite/harness-cursor-sdk@${CURSOR_VERSION}`)
  }
})

function listingPackage(dir: string, tarball: string): string {
  return spawnSync('tar', ['xzf', join(dir, tarball), '-O', 'package/package.json'], {
    encoding: 'utf8',
  }).stdout
}
