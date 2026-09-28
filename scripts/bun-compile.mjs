// Checks that `bun build --compile` still makes a working es from dist/. Local and optional: ES
// runs on Node, and nothing ships a binary. Needs bun on PATH and `pnpm build` first.
//
//   node scripts/bun-compile.mjs
//
// It writes packages/evalsuite/es (gitignored), which finds ES's own files (package.json, dist/,
// docker/, assets/) beside itself, then runs examples/hello's fake config with it and with Node
// and compares them. With Docker running and the sandbox images built, it also runs one egress
// fixture in Docker with the binary.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = join(root, 'packages/evalsuite')
const cli = join(pkg, 'dist/cli.js')
const binary = join(pkg, process.platform === 'win32' ? 'es.exe' : 'es')

const fail = (message) => {
  console.error(`bun-compile: ${message}`)
  process.exit(1)
}
const sh = (command, args, options = {}) =>
  spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options })

if (sh('bun', ['--version']).status !== 0) fail('bun is not on PATH (https://bun.sh)')
if (!existsSync(cli)) fail('no dist/cli.js: run pnpm build first')

const built = sh(
  'bun',
  ['build', '--compile', '--compile-autoload-package-json', cli, '--outfile', binary],
  { cwd: pkg, stdio: 'inherit' },
)
if (built.status !== 0) fail('bun build --compile failed')

/** A copy of `dir` outside the repo, importing ES as `evalsuite` from this checkout. */
function project(dir) {
  const copy = mkdtempSync(join(tmpdir(), 'es-bun-'))
  cpSync(dir, copy, {
    recursive: true,
    filter: (src) => !/[/\\](node_modules|\.es)([/\\]|$)/.test(src.slice(dir.length)),
  })
  mkdirSync(join(copy, 'node_modules'))
  symlinkSync(pkg, join(copy, 'node_modules/evalsuite'), 'dir')
  return copy
}

const node = (cwd, args, env) =>
  sh(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env } })
const compiled = (cwd, args, env) => sh(binary, args, { cwd, env: { ...process.env, ...env } })
/** The last line that says how the run went, e.g. `10 passed, 1 missed, not gated (…)`. */
const outcome = (r) =>
  (r.stdout + r.stderr)
    .split('\n')
    .filter((l) => /\d+ (passed|failed)/.test(l))
    .at(-1)
const planned = (r) =>
  JSON.parse(r.stdout).evals.map((e) => `${e.file} › ${e.name} ${JSON.stringify(e.cells ?? [])}`)

const checks = []
const check = (name, ok, detail = '') => {
  checks.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}

const version = compiled(pkg, ['--version'])
check('es --version', version.stdout.trim() === node(pkg, ['--version']).stdout.trim())

const hello = project(join(root, 'examples/hello'))
const fake = ['--config', 'es.fake.config.ts']
const [planNode, planBin] = [node, compiled].map((es) =>
  es(hello, ['run', ...fake, '--dry-run', '--json']),
)
check(
  'the same plan',
  planBin.status === 0 && JSON.stringify(planned(planBin)) === JSON.stringify(planned(planNode)),
  planBin.status === 0 ? '' : planBin.stderr,
)
const [runNode, runBin] = [node, compiled].map((es) => es(hello, ['run', ...fake]))
check(
  'the same run',
  runBin.status === runNode.status && outcome(runBin) === outcome(runNode),
  outcome(runBin) ?? runBin.stderr,
)
const query = compiled(hello, ['query', 'effort', '--json'])
check('es query (node:sqlite)', query.status === 0, query.status === 0 ? '' : query.stderr)
const studio = compiled(hello, ['studio', 'build', '--out', join(hello, 'site')])
check('es studio build', studio.status === 0, studio.status === 0 ? '' : studio.stderr)

const docker = sh('docker', ['image', 'inspect', 'evalsuite-sandbox-base:latest'])
if (docker.status === 0) {
  // The egress gateway and a Docker attempt: the lands eval passes and its canary fails.
  const fixture = project(join(pkg, 'test/features/egress/blocked-host-recorded'))
  const r = compiled(fixture, ['run'], { ES_FIXTURE_SANDBOX: 'docker' })
  check(
    'a Docker attempt behind the gateway',
    /1 passed, 1 failed/.test(outcome(r) ?? ''),
    outcome(r) ?? r.stderr,
  )
  rmSync(fixture, { recursive: true, force: true })
} else console.log('skip a Docker attempt: no Docker, or no sandbox images (es image build)')

rmSync(hello, { recursive: true, force: true })
if (checks.includes(false)) fail('the compiled es differs from Node')
console.log(`bun-compile: ${binary} works`)
