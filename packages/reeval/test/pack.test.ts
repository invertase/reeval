import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, sep } from 'node:path'
import { test } from 'node:test'
import { VERSION } from '@reeval/harness-antigravity'
import { VERSION as CURSOR_VERSION } from '@reeval/harness-cursor-sdk'
import { baseEnv, fakeConfig, pkgRoot, readRun, spawnTool, tempDir } from './helpers.ts'

const sh = (cmd: string, cwd: string, args: string[], timeout = 120_000) =>
  spawnTool(cmd, args, { cwd, env: baseEnv, encoding: 'utf8', timeout })

const hasTools =
  sh('pnpm', pkgRoot, ['--version']).status === 0 &&
  sh('npm', pkgRoot, ['ping'], 15_000).status === 0
/** In CI a missing tool fails the tests that need it rather than skipping them. */
const noTools = !hasTools && !process.env.CI && 'needs pnpm, npm and the registry'
const hasYarn = sh('yarn', tmpdir(), ['--version']).status === 0
const hasCorepack = sh('corepack', tmpdir(), ['--version']).status === 0
/** Yarn Berry, through corepack, without its download prompt. */
const berry = (cwd: string, args: string[], timeout = 240_000) =>
  spawnTool('corepack', ['yarn', ...args], {
    cwd,
    env: { ...baseEnv, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
    encoding: 'utf8',
    timeout,
  })
// Linux containers: Windows runners' Docker runs Windows containers only, which reeval refuses.
const hasDocker =
  sh('docker', pkgRoot, ['info', '--format', '{{.OSType}}']).stdout?.trim() === 'linux'

/** Packs the package into a fresh directory. */
function pack() {
  const dir = tempDir('packed')
  const packed = sh('pnpm', pkgRoot, ['pack', '--pack-destination', dir])
  assert.equal(packed.status, 0, packed.stdout + packed.stderr)
  const tarball = readdirSync(dir).find((f) => f.endsWith('.tgz')) as string
  assert.ok(tarball, readdirSync(dir).join(', '))
  const manifest = JSON.parse(extract(dir, tarball, 'package.json'))
  return { dir, tarball, manifest, pkg: manifest.name as string }
}

/** An empty project next to the tarball, with the fake config and one eval. */
async function makeApp(dir: string, pkg: string) {
  const app = join(dir, 'app')
  await mkdir(join(app, 'evals'), { recursive: true })
  await writeFile(join(app, 'package.json'), '{ "name": "app", "private": true, "type": "module" }')
  await writeFile(join(app, 'reeval.config.ts'), fakeConfig().replaceAll("'reeval", `'${pkg}`))
  await writeFile(
    join(app, 'evals/hello.eval.ts'),
    `import { evaluate, expect } from '${pkg}'
evaluate('hello', async (c) => {
  await c.send('say hi')
  expect(await c.judge('Did it say hi?')).toPass()
})
`,
  )
  return app
}

// Yarn doesn't install peer dependencies, and neither does pnpm without auto-install-peers, so
// everything reeval loads must be one of the package's own dependencies. Strict peers also fails
// the install when a dependency's required peer isn't met.
const installers = [
  {
    name: 'yarn',
    cmd: 'yarn',
    // CI's runners have Yarn 1, so there a missing one fails.
    skip: !hasYarn && !process.env.CI && 'needs yarn',
    // Yarn caches a file: tarball by name and version, so a fresh cache installs this one.
    args: (tarball: string) => [
      'add',
      '--non-interactive',
      '--no-progress',
      '--cache-folder',
      '../yarn-cache',
      `file:../${tarball}`,
    ],
  },
  {
    name: 'pnpm, strict about peers',
    cmd: 'pnpm',
    skip: false,
    args: (tarball: string) => [
      'add',
      '--ignore-workspace',
      '--config.auto-install-peers=false',
      '--config.strict-peer-dependencies=true',
      `../${tarball}`,
    ],
  },
]

for (const installer of installers) {
  test(`the packed package installs with ${installer.name} and runs reeval`, {
    skip: noTools || installer.skip,
    timeout: 600_000,
  }, async () => {
    const { dir, tarball, manifest, pkg } = pack()
    const app = await makeApp(dir, pkg)
    const added = sh(installer.cmd, app, installer.args(tarball), 240_000)
    assert.equal(added.status, 0, added.stdout + added.stderr)
    const es = (...args: string[]) => sh(join(app, 'node_modules/.bin/reeval'), app, args, 60_000)
    assert.equal(es('--version').stdout.trim(), manifest.version)
    const run = es('run')
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /✓ evals\/hello\.eval\.ts › hello/)
  })
}

// A project's own Vitest, another major for its own unit tests, is never loaded or run by reeval.
test("the packed package runs beside the project's own, different vitest", {
  skip: noTools,
  timeout: 600_000,
}, async () => {
  const { dir, tarball, pkg } = pack()
  const app = await makeApp(dir, pkg)
  await writeFile(join(app, 'vitest.config.ts'), 'export default {}\n')
  await mkdir(join(app, 'src'), { recursive: true })
  await writeFile(
    join(app, 'src/sum.test.ts'),
    "import { expect, test } from 'vitest'\ntest('sum', () => expect(1 + 1).toBe(2))\n",
  )
  const added = sh(
    'npm',
    app,
    ['install', '--no-audit', '--no-fund', 'vitest@3.2.4', `../${tarball}`],
    300_000,
  )
  assert.equal(added.status, 0, added.stdout + added.stderr)
  const theirs = JSON.parse(readFileSync(join(app, 'node_modules/vitest/package.json'), 'utf8'))
  assert.equal(theirs.version, '3.2.4')
  const run = sh(join(app, 'node_modules/.bin/reeval'), app, ['run', '--ui', 'plain'], 60_000)
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /✓ evals\/hello\.eval\.ts › hello/)
  assert.doesNotMatch(run.stdout + run.stderr, /sum\.test|warning/)
  // The canary: the project's own vitest still runs its own tests.
  const unit = sh(join(app, 'node_modules/.bin/vitest'), app, ['run', 'src'], 120_000)
  assert.equal(unit.status, 0, unit.stdout + unit.stderr)
  assert.match(unit.stdout, /1 passed/)
})

// Plug'n'Play has no node_modules: the CLI, its worker and jiti resolve everything through
// .pnp.cjs, and reeval asks to be unplugged so its files (the worker, Docker's build context) are
// on disk rather than inside Yarn's zip cache.
test("the packed package installs with Yarn Berry's Plug'n'Play and runs reeval", {
  skip: noTools || (!hasCorepack && !process.env.CI && 'needs corepack'),
  timeout: 600_000,
}, async () => {
  const { dir, tarball, manifest, pkg } = pack()
  const app = await makeApp(dir, pkg)
  const project = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'))
  await writeFile(
    join(app, 'package.json'),
    JSON.stringify({ ...project, packageManager: 'yarn@4.18.1' }),
  )
  await writeFile(
    join(app, '.yarnrc.yml'),
    'nodeLinker: pnp\nenableGlobalCache: false\nenableTelemetry: false\n',
  )
  const added = berry(app, ['add', `${pkg}@file:../${tarball}`])
  assert.equal(added.status, 0, added.stdout + added.stderr)
  assert.ok(!existsSync(join(app, 'node_modules')), 'no node_modules under PnP')
  assert.ok(
    readdirSync(join(app, '.yarn/unplugged')).some((d) => d.startsWith(pkg.replace('/', '-'))),
    'reeval is unplugged',
  )
  assert.equal(berry(app, ['reeval', '--version']).stdout.trim(), manifest.version)
  const run = berry(app, ['reeval', 'run', '--ui', 'plain'], 60_000)
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /✓ evals\/hello\.eval\.ts › hello/)
})

test('the packed package installs into a clean project and runs reeval', {
  skip: noTools,
  timeout: 900_000,
}, async () => {
  const { dir, tarball, manifest, pkg } = pack()
  const listing = sh('tar', dir, ['tzf', tarball]).stdout
  assert.match(listing, /^package\/LICENSE$/m)
  assert.match(listing, /^package\/dist\/cli\.js$/m)
  assert.match(listing, /^package\/dist\/studio-app\/index\.html$/m)
  for (const entry of ['index', 'harness', 'sandbox', 'judge', 'view/index']) {
    assert.match(listing, new RegExp(`^package/dist/${entry}\\.js$`, 'm'))
    assert.match(listing, new RegExp(`^package/dist/${entry}\\.d\\.ts$`, 'm'))
  }
  // The bundled packages' other files, beside dist/ as in their own packages.
  assert.match(listing, /^package\/docker\/Dockerfile$/m)
  assert.match(listing, /^package\/assets\/pnpm-lock\.yaml$/m)
  assert.doesNotMatch(listing, /^package\/(src|test)\//m)
  assert.doesNotMatch(listing, /^package\/dist\/studio-app\/third-party\.json$/m)

  // The @reeval/* packages are bundled into dist, so nothing in the manifest points at the
  // workspace.
  assert.equal(manifest.license, 'Apache-2.0')
  assert.doesNotMatch(JSON.stringify(manifest), /workspace:/)
  assert.ok(!Object.keys(manifest.dependencies).some((d) => d.startsWith('@reeval/')))

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

  const app = await makeApp(dir, pkg)
  // --prefer-online: a stale cached packument misses versions published since, but tarballs
  // still come from the cache.
  const added = sh(
    'npm',
    app,
    ['install', '--no-audit', '--no-fund', '--prefer-online', `../${tarball}`],
    240_000,
  )
  assert.equal(added.status, 0, added.stdout + added.stderr)

  const es = (...args: string[]) => sh(join(app, 'node_modules/.bin/reeval'), app, args, 60_000)
  assert.equal(es('--version').stdout.trim(), manifest.version)
  assert.equal(es('image', 'build', '--help').status, 0)
  const run = es('run')
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /✓ evals\/hello\.eval\.ts › hello/)
  assert.equal(es('show').status, 0)
  // Adapters the package bundles can't be resolved by name, but the run still records them.
  assert.equal(readRun(app).run.stack.packages['@reeval/harness-antigravity'], VERSION)

  // Nothing that ships imports an @reeval/* package, and every chunk loads with the installed
  // package's dependencies alone. cli.js runs `reeval` or `reeval __worker` by importing the CLI's chunk
  // or the worker's; those run on import, and so do the chunks only they reach, which import them.
  const dist = join(app, 'node_modules', pkg, 'dist')
  const shipped = readdirSync(dist, { recursive: true, encoding: 'utf8' }).map((f) =>
    f.replaceAll(sep, '/'),
  )
  const code = shipped.filter((f) => /\.(js|d\.ts)$/.test(f) && !f.startsWith('studio-app/'))
  const source = (file: string) => readFileSync(join(dist, file), 'utf8')
  for (const file of code)
    assert.doesNotMatch(source(file), /(?:\bfrom|\bimport)\s*\(?\s*['"]@reeval\//, file)
  const dispatched = [...source('cli.js').matchAll(/\bimport\("\.\/([^"]+)"\)/g)].map(
    (m) => m[1] as string,
  )
  const cliChunk = dispatched.find((f) => /^cli-[\w-]+\.js$/.test(f))
  const workerChunk = dispatched.find((f) => /^worker-entry-[\w-]+\.js$/.test(f))
  assert.ok(cliChunk && workerChunk && dispatched.length === 2, dispatched.join(', '))
  const imports = (file: string) =>
    [...source(file).matchAll(/\bfrom\s*"(\.\.?\/[^"]+)"/g)].map((m) =>
      posix.join(posix.dirname(file), m[1] as string),
    )
  const runsOnImport = (file: string, seen = new Set<string>()): boolean =>
    ['cli.js', ...dispatched].includes(file) ||
    imports(file).some((f) => !seen.has(f) && seen.add(f) && runsOnImport(f, seen))
  const chunks = code.filter((f) => f.endsWith('.js') && !runsOnImport(f))
  assert.ok(chunks.includes('index.js') && chunks.length > 10, chunks.join(', '))
  const loaded = sh(process.execPath, app, [
    '--input-type=module',
    '-e',
    `for (const f of ${JSON.stringify(chunks)}) await import('./node_modules/${pkg}/dist/' + f)`,
  ])
  assert.equal(loaded.status, 0, loaded.stderr)

  // What users and reeval's workers load (every export, and the worker's chunk) never reaches the
  // CLI's chunk, whose import runs the CLI, following import() as well as static imports.
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
    workerChunk,
  ]
  assert.ok(entries.includes('harness.js') && entries.includes('view/index.js'), entries.join())
  for (const entry of entries) {
    const via = reached(entry)
    const path: string[] = []
    for (let f: string | null | undefined = cliChunk; f; f = via.get(f)) path.unshift(f)
    assert.equal(via.has(cliChunk), false, `${entry} reaches the CLI: ${path.join(' → ')}`)
    assert.equal(via.has('cli.js'), false, `${entry} reaches cli.js`)
  }
  // The canary: the walk follows import(), which is how the CLI loads most of itself.
  assert.ok(reached('cli.js').size > reached('cli.js', false).size)

  if (hasDocker) {
    // `reeval image build` builds Cursor's image from the docker/ directory in the installed package.
    await writeFile(
      join(app, 'reeval.cursor.config.ts'),
      `import { defineConfig } from '${pkg}'
import { cursor } from '${pkg}/harness'
import { docker } from '${pkg}/sandbox'
export default defineConfig({ harness: cursor({ model: 'composer-2.5' }) })
`,
    )
    const built = sh(
      join(app, 'node_modules/.bin/reeval'),
      app,
      ['image', 'build', '--config', 'reeval.cursor.config.ts'],
      600_000,
    )
    assert.equal(built.status, 0, built.stdout + built.stderr)
    const label = sh('docker', app, [
      'image',
      'inspect',
      '--format',
      '{{ index .Config.Labels "ai.reeval.harness" }}',
      `reeval-sandbox:cursor-${CURSOR_VERSION}`,
    ])
    assert.equal(label.stdout.trim(), `@reeval/harness-cursor-sdk@${CURSOR_VERSION}`)
  }
})

function extract(dir: string, tarball: string, file: string): string {
  // Relative to `dir`: GNU tar reads a `C:` in a Windows path as a remote host.
  return spawnSync('tar', ['xzf', tarball, '-O', `package/${file}`], {
    cwd: dir,
    encoding: 'utf8',
  }).stdout
}
