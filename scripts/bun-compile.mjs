// Checks that `bun build --compile` still makes a working, standalone reeval from dist/. reeval
// runs on Node; binary.yml builds these binaries in CI. Needs bun on PATH and `pnpm build` first.
//
//   node scripts/bun-compile.mjs
//   node scripts/bun-compile.mjs --target bun-linux-arm64 --outfile out/reeval-linux-arm64
//
// It writes packages/reeval/reeval (gitignored), or --outfile, with reeval's own files embedded
// (package.json, docker/, bin/, assets/, skills/, dist/studio-app, dist/bridge, jiti's Babel build
// and the bundled dependencies' versions). For this machine's target it then copies it into an
// empty directory and runs examples/hello's fake config with it, in a copy with no node_modules,
// and with Node, and compares them. With Docker running and the sandbox images built, it also
// runs one egress fixture in Docker with it. Another --target is only compiled; --no-check skips
// the checks.
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    target: { type: 'string' },
    outfile: { type: 'string' },
    'no-check': { type: 'boolean', default: false },
  },
})
const native = `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`
const target = args.target ?? native
// A -musl or -baseline target runs here too, but the checks run only the build for this machine.
const runsHere = target === native

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = join(root, 'packages/reeval')
const cli = join(pkg, 'dist/cli.js')
const exe = target.includes('windows') ? 'reeval.exe' : 'reeval'
const binary = args.outfile ? resolve(args.outfile) : join(pkg, exe)

const fail = (message) => {
  console.error(`bun-compile: ${message}`)
  process.exit(1)
}
const sh = (command, args, options = {}) =>
  spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options })

const bun = sh('bun', ['--version'])
if (bun.status !== 0) fail('bun is not on PATH (https://bun.sh)')
if (!existsSync(cli)) fail('no dist/cli.js: run pnpm build first')

// What the binary embeds, laid out as in the package; src/root.ts finds it there when compiled.
const stage = mkdtempSync(join(tmpdir(), 'reeval-bun-stage-'))
const own = ['package.json', 'docker', 'bin', 'assets', 'skills', 'dist/studio-app', 'dist/bridge']
for (const path of own) cpSync(join(pkg, path), join(stage, path), { recursive: true })
const require = createRequire(join(pkg, 'package.json'))
const jiti = dirname(require.resolve('jiti/package.json'))
mkdirSync(join(stage, 'vendor/jiti'), { recursive: true })
cpSync(join(jiti, 'dist/babel.cjs'), join(stage, 'vendor/jiti/babel.cjs'))
const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'))
const versions = Object.fromEntries(
  Object.keys(manifest.dependencies).map((name) => [
    name,
    JSON.parse(readFileSync(join(pkg, 'node_modules', name, 'package.json'), 'utf8')).version,
  ]),
)
writeFileSync(join(stage, 'versions.json'), `${JSON.stringify(versions, null, 2)}\n`)

// An --asset directory keeps its path from its parent, so dist/ goes in whole (it's staged with
// only the studio app and the bridge).
const assets = [
  'package.json',
  'docker',
  'bin',
  'assets',
  'skills',
  'dist',
  'vendor',
  'versions.json',
].flatMap((path) => ['--asset', path])
const built = sh(
  'bun',
  [
    'build',
    '--compile',
    // reeval reads .env files itself, in its own order; the executable mustn't load them first.
    '--no-compile-autoload-dotenv',
    '--no-compile-autoload-bunfig',
    '--compile-autoload-package-json',
    `--target=${target}`,
    cli,
    ...assets,
    '--outfile',
    binary,
  ],
  { cwd: stage, stdio: 'inherit' },
)
rmSync(stage, { recursive: true, force: true })
if (built.status !== 0) fail('bun build --compile failed')
if (args['no-check'] || !runsHere) {
  console.log(`bun-compile: ${binary} (${target}), not checked`)
  process.exit(0)
}

// The binary alone, in an empty directory, with its own cache for what it copies out of itself.
const alone = mkdtempSync(join(tmpdir(), 'reeval-bun-alone-'))
cpSync(binary, join(alone, exe))
const cache = join(alone, 'cache')

/** A copy of `dir` outside the repo; with `link`, importing reeval as `reeval` from here. */
function project(dir, link) {
  const copy = mkdtempSync(join(tmpdir(), 'reeval-bun-'))
  cpSync(dir, copy, {
    recursive: true,
    filter: (src) => !/[/\\](node_modules|\.reeval)([/\\]|$)/.test(src.slice(dir.length)),
  })
  if (link) {
    mkdirSync(join(copy, 'node_modules'))
    symlinkSync(pkg, join(copy, 'node_modules/reeval'), 'dir')
  }
  return copy
}

const node = (cwd, args, env) =>
  sh(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env } })
const compiled = (cwd, args, env) =>
  sh(join(alone, exe), args, { cwd, env: { ...process.env, XDG_CACHE_HOME: cache, ...env } })
/** The last line that says how the run went, e.g. `16 pass` or `1 fail · 1 pass`. */
const outcome = (r) =>
  (r.stdout + r.stderr)
    .split('\n')
    .filter((l) => /^\d+ (pass|fail)/.test(l.trim()))
    .at(-1)
    ?.trim()
const planned = (r) =>
  JSON.parse(r.stdout).evals.map((e) => `${e.file} › ${e.name} ${JSON.stringify(e.cells ?? [])}`)
const why = (r) => (r.status === 0 ? '' : (r.stderr || r.stdout).trim().slice(-600))

const checks = []
const check = (name, ok, detail = '') => {
  checks.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}

console.log(`bun ${bun.stdout.trim()}, ${binary}`)
const version = compiled(alone, ['--version'])
check('reeval --version', version.stdout.trim() === manifest.version, why(version))

const withNode = project(join(root, 'examples/hello'), true)
const hello = project(join(root, 'examples/hello'), false)
const fake = ['--config', 'reeval.fake.config.ts']
const planNode = node(withNode, ['run', ...fake, '--dry-run', '--json'])
const planBin = compiled(hello, ['run', ...fake, '--dry-run', '--json'])
check(
  'the same plan, with no node_modules',
  planBin.status === 0 && JSON.stringify(planned(planBin)) === JSON.stringify(planned(planNode)),
  why(planBin),
)
const runNode = node(withNode, ['run', ...fake])
const runBin = compiled(hello, ['run', ...fake])
check(
  'the same run',
  outcome(runBin) !== undefined &&
    runBin.status === runNode.status &&
    outcome(runBin) === outcome(runNode),
  outcome(runBin) ?? why(runBin),
)
const query = compiled(hello, ['query', 'effort', '--json'])
check('reeval query (node:sqlite)', query.status === 0, why(query))
const site = join(hello, 'site')
const studio = compiled(hello, ['studio', 'build', '--out', site])
check(
  'reeval studio build',
  studio.status === 0 && existsSync(join(site, 'index.html')),
  why(studio),
)

const docker = sh('docker', ['image', 'inspect', 'reeval-sandbox-base:latest'])
if (docker.status === 0) {
  // The egress gateway and a Docker attempt: the lands eval passes and its canary fails.
  const fixture = project(join(pkg, 'test/features/egress/blocked-host-recorded'), false)
  const r = compiled(fixture, ['run'], { REEVAL_FIXTURE_SANDBOX: 'docker' })
  check(
    'a Docker attempt behind the gateway',
    r.status === 1 && outcome(r) === '1 fail · 1 pass',
    outcome(r) ?? why(r),
  )
  rmSync(fixture, { recursive: true, force: true })
} else console.log('skip a Docker attempt: no Docker, or no sandbox images (reeval image build)')
const copied = existsSync(cache) ? readdirSync(join(cache, 'reeval')).sort() : []
check('what it copied out of itself', copied.length > 0, copied.join(', '))

for (const dir of [withNode, hello, alone]) rmSync(dir, { recursive: true, force: true })
if (checks.includes(false)) fail('the compiled reeval differs from Node')
console.log(`bun-compile: ${binary} works on its own`)
