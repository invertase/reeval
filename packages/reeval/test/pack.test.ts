import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, symlinkSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix, sep } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { VERSION } from '@reeval/harness-antigravity'
import { VERSION as CURSOR_VERSION } from '@reeval/harness-cursor-sdk'
import { packageReadme } from '../../../scripts/package-readme.mjs'
import { baseEnv, fakeConfig, pkgRoot, readRun, spawnTool, tempDir } from './helpers.ts'
import { type FakeBoat, fakeBoat, unreachableMachines } from './support/boat.ts'
import { fakeS3 } from './support/fake-s3.ts'

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
  expect(await c.judge('Did it say hi?', { diff: true })).toPass()
})
`,
  )
  return app
}

// Yarn doesn't install peer dependencies, and neither does pnpm without auto-install-peers, so
// everything reeval loads must be one of the package's own dependencies, except the optional Boat
// SDK, which only boat() loads and the project installs itself. Strict peers also fails the
// install when a dependency's required peer isn't met.
const installers = [
  {
    name: 'yarn',
    cmd: 'yarn',
    addSdk: ['add', '--non-interactive', '--no-progress', '--cache-folder', '../yarn-cache'],
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
    addSdk: [
      'add',
      '--ignore-workspace',
      '--config.auto-install-peers=false',
      '--config.strict-peer-dependencies=true',
    ],
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
    const cli = (...args: string[]) => sh(join(app, 'node_modules/.bin/reeval'), app, args, 60_000)
    assert.equal(cli('--version').stdout.trim(), manifest.version)
    const run = cli('run')
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /^└─ ✓ hello {2}1 of 1 run passed$/m)
    await boatInApp(app, pkg, binCli(app), () => {
      const sdk = sh(
        installer.cmd,
        app,
        [...installer.addSdk, `${BOAT_SDK}@${boatPeer(manifest)}`],
        240_000,
      )
      assert.equal(sdk.status, 0, sdk.stdout + sdk.stderr)
    })
    await storeInApp(app, pkg, binCli(app))
  })
}

const BOAT_SDK = '@boatdev/sdk'
/** The lowest version the package's peer range takes. */
const boatPeer = (manifest: { peerDependencies: Record<string, string> }) =>
  (manifest.peerDependencies[BOAT_SDK] ?? '').replace(/^\^/, '')

type Cli = (
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
) => Promise<{ status: number | null; out: string }>

/** A command, run without blocking this process, which serves the fake Boat API. */
const spawnAsync = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  new Promise<{ status: number | null; out: string }>((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...baseEnv, ...env },
      shell: process.platform === 'win32',
    })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      out += d
    })
    child.on('close', (status) => resolve({ status, out }))
  })

/** The CLI an installer put in the project's node_modules/.bin. */
const binCli =
  (app: string): Cli =>
  (args, env, cwd = app) =>
    spawnAsync(join(app, 'node_modules/.bin/reeval'), args, cwd, env)

const BOAT_CONFIG = (pkg: string) => `import { defineConfig } from '${pkg}'
import { fakeHarness } from '${pkg}/harness'
import { boat } from '${pkg}/sandbox/boat'
export default defineConfig({ harnesses: fakeHarness(), sandbox: boat(), egress: 'allow-all' })
`

/**
 * boat() in a packed install: without the optional Boat SDK, core never loads it and a run stops
 * on its absence with the install sentence; with it, `doctor --online` loads it from the project
 * and reaches the (fake) Boat API.
 */
async function boatInApp(app: string, pkg: string, cli: Cli, addSdk: () => void) {
  await writeFile(join(app, 'reeval.boat.config.ts'), BOAT_CONFIG(pkg))
  const api = await fakeBoat(unreachableMachines)
  try {
    const env = { BOAT_BASE_URL: api.url, BOAT_API_KEY: api.key }
    const config = ['--config', 'reeval.boat.config.ts']
    const planned = await cli(['run', '--dry-run', ...config], {})
    assert.equal(planned.status, 0, planned.out)
    const refused = await cli(['run', ...config], env)
    assert.equal(refused.status, 2, refused.out)
    assert.match(refused.out, /Install the Boat SDK in this project: npm i @boatdev\/sdk/)
    assert.deepEqual(api.live(), [])
    addSdk()
    await reachesBoat(cli, api, app)
  } finally {
    await api.close()
  }
}

const STORE_CONFIG = (
  pkg: string,
  url: string,
  bucket: string,
) => `import { defineConfig } from '${pkg}'
import { fakeHarness } from '${pkg}/harness'
import { fakeJudge } from '${pkg}/judge'
import { fakeSandbox } from '${pkg}/sandbox'
import { local } from '${pkg}/store/local'
import { s3 } from '${pkg}/store/s3'
export default defineConfig({
  harnesses: fakeHarness(),
  sandbox: fakeSandbox(),
  judge: { model: fakeJudge({ score: 0.9 }) },
  history: { store: local({ dir: 'runs' }) },
  profiles: {
    ci: { history: { store: s3({ bucket: '${bucket}', endpoint: '${url}', prefix: 'packed' }) } },
  },
})
`

/**
 * s3() in a packed install: the S3 client is one of reeval's own dependencies, so a run with
 * `--profile ci --record` uploads with whatever the installer laid out.
 */
async function storeInApp(app: string, pkg: string, cli: Cli) {
  const s3 = await fakeS3()
  try {
    await writeFile(join(app, 'reeval.store.config.ts'), STORE_CONFIG(pkg, s3.url, s3.bucket))
    const env = {
      AWS_ACCESS_KEY_ID: s3.accessKey,
      AWS_SECRET_ACCESS_KEY: s3.secretKey,
      CI: 'false',
    }
    const config = ['--config', 'reeval.store.config.ts']
    const run = await cli(['run', ...config, '--profile', 'ci', '--record'], env)
    assert.equal(run.status, 0, run.out)
    assert.match(run.out, /^recorded \S+ in s3:\/\/reeval-runs\/packed /m)
    assert.ok(
      [...s3.objects.keys()].some((k) => /^packed\/runs\/\d{4}-\d{2}\/[^/]+\.json$/.test(k)),
    )
  } finally {
    await s3.close()
  }
}

/** `doctor --online` in `cwd` loads the project's Boat SDK and reaches the fake Boat API. */
async function reachesBoat(cli: Cli, api: FakeBoat, cwd: string) {
  api.requests.length = 0
  const env = { BOAT_BASE_URL: api.url, BOAT_API_KEY: api.key }
  const doctor = await cli(
    ['doctor', '--online', '--json', '--config', 'reeval.boat.config.ts'],
    env,
    cwd,
  )
  const row = JSON.parse(doctor.out).checks.find((c: { id: string }) => c.id === 'boat')
  assert.equal(row?.status, 'ok', doctor.out)
  assert.ok(
    api.requests.some((q) => q.call === 'GET /limits'),
    'doctor reached Boat',
  )
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
  assert.match(run.stdout, /^└─ ✓ hello {2}1 of 1 run passed$/m)
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
    // Yarn 4.18's default 1-day age gate would refuse a pin published today.
    'nodeLinker: pnp\nenableGlobalCache: false\nenableTelemetry: false\nnpmMinimalAgeGate: 0\n',
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
  assert.match(run.stdout, /^└─ ✓ hello {2}1 of 1 run passed$/m)
  const cli: Cli = (args, env) =>
    spawnAsync('corepack', ['yarn', 'reeval', ...args], app, {
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      ...env,
    })
  await boatInApp(app, pkg, cli, () => {
    const sdk = berry(app, ['add', `${BOAT_SDK}@${boatPeer(manifest)}`])
    assert.equal(sdk.status, 0, sdk.stdout + sdk.stderr)
  })
  await storeInApp(app, pkg, cli)
})

test('the packed package installs into a clean project and runs reeval', {
  skip: noTools,
  timeout: 900_000,
}, async () => {
  const { dir, tarball, manifest, pkg } = pack()
  const listing = sh('tar', dir, ['tzf', tarball]).stdout
  assert.match(listing, /^package\/LICENSE$/m)
  // The published README is the repo-root README with its relative links made absolute, since
  // the docs they point to don't ship; the CHANGELOG ships as it is.
  assert.match(listing, /^package\/README\.md$/m)
  const readme = extract(dir, tarball, 'README.md')
  assert.equal(
    readme,
    packageReadme(readFileSync(join(pkgRoot, '..', '..', 'README.md'), 'utf8'), manifest.version),
  )
  assert.doesNotMatch(readme, /\]\((?!https?:|mailto:|#)/, 'no relative link')
  assert.match(readme, /\]\(https:\/\/github\.com\/invertase\/reeval\/blob\/v[^/]+\/docs\//)
  assert.doesNotMatch(listing, /^package\/docs\//m)
  assert.equal(
    extract(dir, tarball, 'CHANGELOG.md'),
    readFileSync(join(pkgRoot, '..', '..', 'CHANGELOG.md'), 'utf8'),
  )
  assert.match(listing, /^package\/dist\/cli\.js$/m)
  assert.doesNotMatch(listing, /^package\/dist\/studio-app\//m, 'the studio app is in a chunk')
  for (const entry of [
    'index',
    'harness',
    'sandbox',
    'sandbox/boat',
    'store/local',
    'store/s3',
    'judge',
    'view/index',
  ]) {
    assert.match(listing, new RegExp(`^package/dist/${entry}\\.js$`, 'm'))
    assert.match(listing, new RegExp(`^package/dist/${entry}\\.d\\.ts$`, 'm'))
  }
  // The bundled packages' other files, beside dist/ as in their own packages.
  assert.match(listing, /^package\/docker\/Dockerfile$/m)
  assert.match(listing, /^package\/assets\/pnpm-lock\.yaml$/m)
  // The consumer skills, copied from the repository's skills/ at build: reeval's, with its
  // references, and the setup and eval rubric skills it links to.
  for (const file of [
    'reeval/SKILL.md',
    'reeval/references/evals.md',
    'setup/SKILL.md',
    'eval-rubric/SKILL.md',
  ]) {
    assert.equal(
      extract(dir, tarball, `skills/${file}`),
      readFileSync(join(pkgRoot, '..', '..', 'skills', file), 'utf8'),
      file,
    )
  }
  assert.doesNotMatch(listing, /^package\/(src|test)\//m)

  // The @reeval/* packages are bundled into dist, so nothing in the manifest points at the
  // workspace.
  assert.equal(manifest.license, 'Apache-2.0')
  assert.doesNotMatch(JSON.stringify(manifest), /workspace:/)
  assert.ok(!Object.keys(manifest.dependencies).some((d) => d.startsWith('@reeval/')))
  // The Boat SDK is the one optional peer: boat() loads it, and nothing else ever does.
  assert.deepEqual(Object.keys(manifest.peerDependencies), [BOAT_SDK])
  assert.deepEqual(manifest.peerDependenciesMeta, { [BOAT_SDK]: { optional: true } })

  // THIRD_PARTY_NOTICES.md: the third-party code inlined into the tarball, each package with
  // its license text, and none of the dependencies npm installs.
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
    assert.match(section, /^- License: \S+/m, section.slice(0, 200))
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
  // The Claude Code bootstrap installs its bridge from these, with its lockfile frozen.
  for (const file of ['index.mjs', 'package.json', 'pnpm-lockfile.yaml', 'pnpm-workspace.yaml'])
    assert.match(listing, new RegExp(`^package/dist/bridge/${file.replace('.', '\\.')}$`, 'm'))

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

  const cli = (...args: string[]) => sh(join(app, 'node_modules/.bin/reeval'), app, args, 60_000)
  assert.equal(cli('--version').stdout.trim(), manifest.version)
  assert.equal(cli('image', 'build', '--help').status, 0)
  const run = cli('run')
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /^└─ ✓ hello {2}1 of 1 run passed$/m)
  assert.equal(cli('show').status, 0)
  // Adapters the package bundles can't be resolved by name, but the run still records them.
  assert.equal(readRun(app).run.stack.packages['@reeval/harness-antigravity'], VERSION)

  // A reeval installed somewhere without the Boat SDK (app/, for now) loads it from the project
  // it runs in.
  const elsewhere = join(dir, 'elsewhere')
  await mkdir(elsewhere)
  await writeFile(join(elsewhere, 'package.json'), '{ "name": "elsewhere", "private": true }')
  await writeFile(join(elsewhere, 'reeval.boat.config.ts'), BOAT_CONFIG(pkg))
  const sdk = (cwd: string) => {
    const r = sh(
      'npm',
      cwd,
      ['install', '--no-audit', '--no-fund', `${BOAT_SDK}@${boatPeer(manifest)}`],
      240_000,
    )
    assert.equal(r.status, 0, r.stdout + r.stderr)
  }
  sdk(elsewhere)
  // Linked, as `npm link` or a shared store does: reeval's own imports resolve from app/.
  await mkdir(join(elsewhere, 'node_modules', dirname(pkg)), { recursive: true })
  symlinkSync(join(app, 'node_modules', pkg), join(elsewhere, 'node_modules', pkg), 'junction')
  assert.ok(!existsSync(join(app, 'node_modules', BOAT_SDK)), 'app/ has no Boat SDK')
  const api = await fakeBoat(unreachableMachines)
  try {
    await reachesBoat(binCli(app), api, elsewhere)
  } finally {
    await api.close()
  }
  await boatInApp(app, pkg, binCli(app), () => sdk(app))
  await storeInApp(app, pkg, binCli(app))

  // Nothing that ships imports an @reeval/* package, and every chunk loads with the installed
  // package's dependencies alone. cli.js runs `reeval` or `reeval __worker` by importing the CLI's chunk
  // or the worker's; those run on import, and so do the chunks only they reach, which import them.
  const dist = join(app, 'node_modules', pkg, 'dist')
  const shipped = readdirSync(dist, { recursive: true, encoding: 'utf8' }).map((f) =>
    f.replaceAll(sep, '/'),
  )
  const code = shipped.filter((f) => /\.(js|d\.ts)$/.test(f))
  const source = (file: string) => readFileSync(join(dist, file), 'utf8')
  const appChunk = shipped.find((f) => /^app-files-[\w-]+\.js$/.test(f))
  assert.ok(appChunk, 'the studio app ships in its own chunk')
  const { APP_FILES } = await import(pathToFileURL(join(dist, appChunk)).href)
  const appPaths = Object.keys(APP_FILES)
  assert.ok(appPaths.includes('index.html'), appPaths.join(', '))
  assert.ok(
    appPaths.some((f) => /^assets\/.+\.js$/.test(f)),
    appPaths.join(', '),
  )
  for (const file of code) {
    assert.doesNotMatch(source(file), /(?:\bfrom|\bimport)\s*\(?\s*['"]@reeval\//, file)
    assert.doesNotMatch(source(file), /\bfrom\s*['"]@boatdev\//, `${file} imports the Boat SDK`)
  }
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
export default defineConfig({ harnesses: cursor({ model: 'composer-2.5' }) })
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
