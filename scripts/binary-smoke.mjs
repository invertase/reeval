// Smoke-tests a compiled reeval on the machine it was built for, with nothing installed: no
// node_modules, no dist/, only Node's built-ins to drive it. binary.yml runs it on each OS.
//
//   node scripts/binary-smoke.mjs <binary> [--docker]
//
// From an empty directory it checks `reeval --version` against packages/reeval/package.json, then
// plans and runs a copy of examples/hello's fake config. Then it builds the studio from that run
// and serves it with `reeval studio`, fetching the app and one of its assets. With --docker it builds the sandbox image
// with the binary and runs one egress fixture in Docker, whose eval passes and canary fails.
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, stripVTControlCharacters } from 'node:util'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { docker: { type: 'boolean', default: false } },
})
if (positionals.length !== 1) {
  console.error('usage: node scripts/binary-smoke.mjs <binary> [--docker]')
  process.exit(2)
}
const root = fileURLToPath(new URL('..', import.meta.url))
const { version } = JSON.parse(readFileSync(join(root, 'packages/reeval/package.json'), 'utf8'))

const alone = mkdtempSync(join(tmpdir(), 'reeval-smoke-'))
const binary = join(alone, basename(positionals[0]))
cpSync(resolve(positionals[0]), binary)
chmodSync(binary, 0o755)
const cache = join(alone, 'cache')
const cacheEnv = { XDG_CACHE_HOME: cache, LOCALAPPDATA: cache }

/** A copy of `dir` in `alone`, without node_modules or .reeval. */
function project(dir, name) {
  const copy = join(alone, name)
  cpSync(dir, copy, {
    recursive: true,
    filter: (src) => !/[/\\](node_modules|\.reeval)([/\\]|$)/.test(src.slice(dir.length)),
  })
  return copy
}

/** Runs the binary in `cwd`, printing its output as it would appear in a terminal. */
function reeval(cwd, args, env = {}) {
  const started = performance.now()
  const r = spawnSync(binary, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...cacheEnv, ...env },
  })
  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  console.log(`\n$ reeval ${args.join(' ')}  (exit ${r.status}, ${seconds}s)`)
  const out = `${r.stdout}${r.stderr}`.trimEnd()
  console.log(args.includes('--json') ? `${out.slice(0, 300)}…` : out)
  return { ...r, out }
}
/** The last line that says how the run went, e.g. `16 pass` or `1 fail · 1 pass`. */
const outcome = (r) =>
  stripVTControlCharacters(r.out)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+ (pass|fail)/.test(l))
    .at(-1)

const failures = []
const check = (name, ok) => {
  if (!ok) failures.push(name)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
}

const v = reeval(alone, ['--version'])
check(`reeval --version is ${version}`, v.status === 0 && v.stdout.trim() === version)

const hello = project(join(root, 'examples/hello'), 'hello')
const fake = ['--config', 'reeval.fake.config.ts']
const plan = reeval(hello, ['run', ...fake, '--dry-run', '--json'])
let evals = 0
try {
  evals = JSON.parse(plan.stdout).evals.length
} catch {}
check(`the fake config plans (${evals} evals)`, plan.status === 0 && evals > 0)
const run = reeval(hello, ['run', ...fake])
check('the fake config runs', run.status === 0 && /^\d+ pass$/.test(outcome(run) ?? ''))

const site = join(hello, 'site')
const built = reeval(hello, ['studio', 'build', ...fake, '--scratch', '--out', site])
const runs = Number(stripVTControlCharacters(built.out).match(/built \S+: (\d+) runs?/)?.[1] ?? 0)
const scripts = existsSync(join(site, 'assets'))
  ? readdirSync(join(site, 'assets')).filter((f) => f.endsWith('.js'))
  : []
check(
  `reeval studio build writes ${runs} run, index.html and ${scripts.length} script`,
  built.status === 0 && runs > 0 && existsSync(join(site, 'index.html')) && scripts.length > 0,
)
await serveStudio(hello)

if (values.docker) {
  const fixture = project(
    join(root, 'packages/reeval/test/features/egress/blocked-host-recorded'),
    'docker',
  )
  const env = { REEVAL_FIXTURE_SANDBOX: 'docker' }
  const image = reeval(fixture, ['image', 'build'], env)
  check('reeval image build', image.status === 0)
  const r = reeval(fixture, ['run'], env)
  check('a Docker attempt behind the gateway', r.status === 1 && outcome(r) === '1 fail · 1 pass')
}

rmSync(alone, { recursive: true, force: true, maxRetries: 5 })
if (failures.length) {
  console.error(`\nbinary-smoke: ${failures.length} failed: ${failures.join('; ')}`)
  process.exit(1)
}
console.log(`\nbinary-smoke: ${basename(binary)} ${version} works on its own`)

/** Starts `reeval studio` in `cwd`, opens its token URL, then fetches `/` and one of its scripts. */
async function serveStudio(cwd) {
  const port = String(43000 + Math.floor(Math.random() * 2000))
  const child = spawn(binary, ['studio', ...fake, '--port', port], {
    cwd,
    windowsHide: true,
    env: { ...process.env, ...cacheEnv },
  })
  let out = ''
  child.stdout.on('data', (d) => {
    out += d
  })
  child.stderr.on('data', (d) => {
    out += d
  })
  try {
    const started = performance.now()
    let url
    while (!url && performance.now() - started < 30_000) {
      url = stripVTControlCharacters(out).match(/https?:\/\/\S+token=\S+/)?.[0]
      if (!url) await new Promise((r) => setTimeout(r, 100))
    }
    console.log(`\n$ reeval studio ${fake.join(' ')} --port ${port}`)
    console.log(stripVTControlCharacters(out).trimEnd())
    if (!url) return check('reeval studio prints its URL', false)
    const opened = await fetch(url, { redirect: 'manual' })
    const cookie = opened.headers.get('set-cookie')?.split(';')[0] ?? ''
    const get = async (path) => {
      const r = await fetch(new URL(path, url), { headers: { cookie } })
      const type = r.headers.get('content-type') ?? ''
      const body = await r.text()
      console.log(`GET ${path} → ${r.status} ${type} (${body.length} bytes)`)
      return { status: r.status, type, body }
    }
    const page = await get('/')
    check(
      'reeval studio serves / as HTML',
      page.status === 200 && page.type.startsWith('text/html') && page.body.includes('<div'),
    )
    const script = page.body.match(/src="(?:\.?\/)?(assets\/[^"]+\.js)"/)?.[1]
    if (!script) return check('index.html names a script', false)
    const asset = await get(`/${script}`)
    check(
      `reeval studio serves /${script} as JavaScript`,
      asset.status === 200 && /javascript/.test(asset.type) && asset.body.length > 1000,
    )
    const style = page.body.match(/href="(?:\.?\/)?(assets\/[^"]+\.css)"/)?.[1]
    const css = style ? await get(`/${style}`) : { status: 0, type: '' }
    check(
      `reeval studio serves /${style} as CSS`,
      css.status === 200 && css.type.startsWith('text/css'),
    )
  } finally {
    child.kill()
    await new Promise((r) => (child.exitCode === null ? child.once('exit', r) : r()))
  }
}
