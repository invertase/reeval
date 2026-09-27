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
  assert.doesNotMatch(listing, /^package\/dist\/studio-app\/third-party\.json$/m)

  // The @evalsuite/* packages are bundled into dist, so nothing in the manifest points at the
  // workspace.
  const manifest = JSON.parse(extract(dir, tarball, 'package.json'))
  const pkg = manifest.name as string
  assert.equal(manifest.license, 'Apache-2.0')
  assert.doesNotMatch(JSON.stringify(manifest), /workspace:/)
  assert.ok(!Object.keys(manifest.dependencies).some((d) => d.startsWith('@evalsuite/')))

  // THIRD_PARTY_NOTICES.md: the third-party code inlined into the tarball, each package with
  // its licence text, and none of the dependencies npm installs.
  assert.match(listing, /^package\/THIRD_PARTY_NOTICES\.md$/m)
  const notices = extract(dir, tarball, 'THIRD_PARTY_NOTICES.md')
  const sections = notices.split(/^## /m).slice(1)
  const listed = sections.map((s) => s.slice(0, s.indexOf('\n')))
  for (const inlined of [
    /^@ai-sdk\/harness-claude-code@/, // dist and dist/bridge
    /^react@/,
    /^react-dom@/,
    /^@radix-ui\/react-select@/,
    /^@tanstack\/react-router@/,
    /^lucide-react@/,
    /^tailwindcss@/, // through the studio's CSS
    /^shadcn\/ui$/,
  ])
    assert.ok(
      listed.some((name) => inlined.test(name)),
      `${inlined} in ${listed.join(', ')}`,
    )
  assert.ok(listed.length > 30, listed.join(', '))
  for (const section of sections) {
    assert.match(section, /^- Licence: \S+/m, section.slice(0, 200))
    assert.match(section, /^```+text\n[\s\S]*(Copyright|Permission)/m, section.slice(0, 200))
  }
  // A dependency can still be inlined into the bridge, which the sandbox runs from its own files.
  const inlinedInto = (name: string) =>
    sections
      .find((s) => s.startsWith(`${name}\n`))
      ?.match(/^- Inlined into: (.*)$/m)?.[1]
      ?.split(', ')
  for (const dep of Object.keys(manifest.dependencies))
    for (const name of listed.filter((n) => n.startsWith(`${dep}@`)))
      assert.ok(!inlinedInto(name)?.includes('dist'), `${dep} is a dependency, not inlined`)
  assert.match(extract(dir, tarball, 'dist/bridge/index.mjs'), /^\/\/ Modified by Invertase/)

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

  // What users and Vitest load (every export, setup.js and worker-signals.js) never reaches
  // cli.js, whose import runs the CLI, following import() as well as static imports.
  const reached = (entry: string, dynamic = true) => {
    const via = new Map<string, string | null>([[entry, null]])
    const pattern = dynamic
      ? /(?:\bfrom\s*|\bimport\s*\(\s*)"(\.\.?\/[^"]+)"/g
      : /\bfrom\s*"(\.\.?\/[^"]+)"/g
    for (const file of via.keys()) {
      for (const m of source(file).matchAll(pattern)) {
        const target = posix.join(posix.dirname(file), m[1] as string)
        if (!via.has(target)) via.set(target, file)
      }
    }
    return via
  }
  const entries = [
    ...Object.values(manifest.exports as Record<string, string | { default: string }>).flatMap(
      (target) => (typeof target === 'string' ? [] : [target.default.replace(/^\.\/dist\//, '')]),
    ),
    'setup.js',
    'worker-signals.js',
  ]
  assert.ok(entries.includes('harness.js') && entries.includes('view/index.js'), entries.join())
  for (const entry of entries) {
    const via = reached(entry)
    const path: string[] = []
    for (let f: string | null | undefined = 'cli.js'; f; f = via.get(f)) path.unshift(f)
    assert.equal(via.has('cli.js'), false, `${entry} reaches cli.js: ${path.join(' → ')}`)
  }
  // The canary: the walk follows import(), which is how the CLI loads most of itself.
  assert.ok(reached('cli.js').size > reached('cli.js', false).size)

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

function extract(dir: string, tarball: string, file: string): string {
  return spawnSync('tar', ['xzf', join(dir, tarball), '-O', `package/${file}`], {
    encoding: 'utf8',
  }).stdout
}
