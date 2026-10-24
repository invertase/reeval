// Smoke-tests a compiled reeval running Python evals on the machine it was built for, with only
// the binary and uv: no Node project, no reeval-python on the machine. binary.yml runs it on each OS.
//
//   node scripts/binary-python-smoke.mjs <binary> --wheel <reeval_python-*-any.whl> [--python 3.11,3.14]
//     [--sdist <reeval_python-*.tar.gz>]
//     [--release <dir with the binaries and SHA256SUMS; default the binary's directory>]
//     [--platform-wheel <reeval_python-*-<platform>.whl, which carries the binary>]
//
// In an empty directory it writes a project with a reeval.yml and a pyproject.toml that depends on
// the wheel (built from the same commit as the binary). For each Python version it runs three
// *.eval.py files on the fake harness and sandbox: one judge-free (it also checks the runner's Python is that version),
// one with the fake judge, and a canary that must fail. Then it runs the project from its .venv
// with no pyproject.toml, so reeval starts .venv's python rather than uv, and checks that a
// reeval-python too old for the binary (0.10.0, from PyPI) and a project without reeval-python
// both stop with how to install it rather than hang. It also runs `uv run reeval`, the SDK's
// launcher, which downloads the binary from --release, checks it against the hashes the wheel
// records and caches it; installs the wheel and the --sdist (what PyPI has) with pip and checks
// they download the same way; and presses Ctrl-C on a run through the pip-installed launcher
// (scripts/ctrl-c.py): reeval must stop the run, save it and exit 130. Given --platform-wheel,
// which carries the binary (built in CI, not published), it runs that offline, installed by uv and
// by pip, and checks pip picks it from the wheels' directories.
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, stripVTControlCharacters } from 'node:util'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    wheel: { type: 'string' },
    sdist: { type: 'string' },
    release: { type: 'string' },
    'platform-wheel': { type: 'string' },
    python: { type: 'string', default: '3.11,3.12,3.13,3.14' },
  },
})
if (positionals.length !== 1 || !values.wheel) {
  console.error('usage: node scripts/binary-python-smoke.mjs <binary> --wheel <whl> [--python …]')
  process.exit(2)
}
const versions = values.python.split(',').map((v) => v.trim())
const wheel = resolve(values.wheel).replaceAll('\\', '/')
// The directory with the binaries and SHA256SUMS, as a release has them, for the SDK's shim.
const release = resolve(values.release ?? dirname(positionals[0]))
// The first run of a version downloads it; a hung runner fails here instead of the job's timeout.
const TIMEOUT = 240_000

const alone = mkdtempSync(join(tmpdir(), 'reeval-py-smoke-'))
const binary = join(alone, basename(positionals[0]))
cpSync(resolve(positionals[0]), binary)
chmodSync(binary, 0o755)
const cache = join(alone, 'cache')
const baseEnv = {
  ...process.env,
  XDG_CACHE_HOME: cache,
  LOCALAPPDATA: cache,
  UV_PYTHON_PREFERENCE: 'only-managed',
  NO_COLOR: '1',
}
delete baseEnv.REEVAL_PYTHON
delete baseEnv.REEVAL_PYTHON_SDK
delete baseEnv.VIRTUAL_ENV
for (const key of ['BINARY', 'DOWNLOAD', 'OFFLINE', 'VERSION']) delete baseEnv[`REEVAL_${key}`]

// reeval.yml, not reeval.config.ts: a Python project has no TypeScript.
const config = (delayMs = 0) => `include: ['evals/**/*.eval.py']
harness:
  kind: fake
  files: { greet.py: "print(\\"hi\\")\\n" }
  text: I wrote greet.py.${delayMs ? `\n  delayMs: ${delayMs}` : ''}
sandbox: { kind: fake }
judge: { model: { kind: fake-judge, score: 1 } }
timeout: 2m
`
const EVALS = {
  'greet.eval.py': `import os
import sys
from pathlib import Path

from reeval_python import evaluate, expect


@evaluate("greet")
def greet(c):
    c.send("Write greet.py, which prints hi")
    expect(c.read_file("greet.py")).to_contain('print("hi")')
    ran = c.exec(f"'{Path(sys.executable).as_posix()}' greet.py")
    expect(ran).to_succeed()
    expect(ran.stdout.strip()).to_be("hi")
    expect(f"{sys.version_info[0]}.{sys.version_info[1]}").to_be(os.environ["SMOKE_PYTHON"])
`,
  'judged.eval.py': `from reeval_python import evaluate


@evaluate("judged")
def judged(c):
    c.send("Write greet.py, which prints hi")
    verdict = c.judge("Does greet.py print hi?")
    assert verdict.passed, f"judge score {verdict.score}"
`,
  'canary.eval.py': `from reeval_python import evaluate, expect


@evaluate("canary")
def canary(c):
    c.send("Write greet.py, which prints hi")
    expect(c.read_file("missing.py")).to_contain("never written")
`,
}

function project(name, dependency, from = wheel, delayMs = 0) {
  const dir = join(alone, name)
  mkdirSync(join(dir, 'evals'), { recursive: true })
  writeFileSync(join(dir, 'reeval.yml'), config(delayMs))
  for (const [file, text] of Object.entries(EVALS)) writeFileSync(join(dir, 'evals', file), text)
  writeFileSync(
    join(dir, 'pyproject.toml'),
    [
      '[project]',
      `name = "${name}"`,
      'version = "0.0.0"',
      'requires-python = ">=3.11"',
      `dependencies = [${dependency ? `"${dependency}"` : ''}]`,
      ...(dependency === 'reeval-python'
        ? ['', '[tool.uv.sources]', `reeval-python = { path = '${from}' }`]
        : []),
      '',
    ].join('\n'),
  )
  return dir
}

/** Runs `command` in `cwd`, printing its output as it would appear in a terminal. */
function sh(command, args, cwd, env = {}) {
  const started = performance.now()
  const r = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: TIMEOUT,
    env: { ...baseEnv, ...env },
  })
  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  const how =
    r.error?.code === 'ETIMEDOUT' ? `hung, killed after ${TIMEOUT / 1000}s` : `exit ${r.status}`
  console.log(
    `\n$ ${Object.entries(env)
      .map(([k, v]) => `${k}=${v} `)
      .join(
        '',
      )}${command === binary ? 'reeval' : command} ${args.join(' ')}  (${how}, ${seconds}s)`,
  )
  const out = stripVTControlCharacters(`${r.stdout ?? ''}${r.stderr ?? ''}`).trimEnd()
  console.log(args.includes('--json') ? `${out.slice(0, 300)}…` : out)
  return { ...r, out }
}
const reeval = (cwd, args, env) => sh(binary, args, cwd, env)
/** The last line that says how the run went, e.g. `1 fail · 2 pass`. */
const outcome = (r) =>
  r.out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+ (pass|fail)/.test(l))
    .at(-1)

const failures = []
const check = (name, ok) => {
  if (!ok) failures.push(name)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
}

const dir = project('smoke', 'reeval-python')
for (const version of versions) {
  rmSync(join(dir, '.venv'), { recursive: true, force: true })
  rmSync(join(dir, 'uv.lock'), { force: true })
  const env = { UV_PYTHON: version, SMOKE_PYTHON: version }
  const plan = reeval(dir, ['run', '--dry-run', '--json'], env)
  let evals = 0
  try {
    evals = JSON.parse(plan.stdout).evals.length
  } catch {}
  check(`Python ${version}: three *.eval.py plan`, plan.status === 0 && evals === 3)
  const run = reeval(dir, ['run'], env)
  check(
    `Python ${version}: greet and judged pass, the canary fails`,
    run.status === 1 &&
      outcome(run) === '1 fail · 2 pass' &&
      /fail\s+canary/.test(run.out) &&
      /missing\.py|never written/.test(run.out),
  )
}

// Without pyproject.toml and uv.lock, reeval starts the project's .venv python itself.
const last = versions.at(-1)
for (const f of ['pyproject.toml', 'uv.lock']) renameSync(join(dir, f), join(dir, `${f}.off`))
const venv = reeval(dir, ['run'], { SMOKE_PYTHON: last })
check(
  `Python ${last} from .venv, without uv: the canary fails`,
  venv.status === 1 && outcome(venv) === '1 fail · 2 pass',
)

// The SDK's own `reeval` command: it fetches this binary from its release directory, checks it
// against the hash the wheel records for it, caches it, and runs the evals on the venv's Python.
for (const f of ['pyproject.toml', 'uv.lock']) renameSync(join(dir, `${f}.off`), join(dir, f))
const version = reeval(alone, ['--version']).stdout.trim()
const wheelVersion = basename(wheel).split('-')[1]
// reeval 1.0.0-beta.1 is reeval-python 1.0.0b1.
const pep440 = (v) =>
  v.replace(
    /-(alpha|beta|rc)\.(\d+)$/,
    (_, pre, n) => `${{ alpha: 'a', beta: 'b', rc: 'rc' }[pre]}${n}`,
  )
check(
  `the wheels are reeval-python ${wheelVersion}, the binary's version`,
  wheelVersion === pep440(version),
)
const download = pathToFileURL(release).href
const shimCache = join(alone, 'shim-cache')
const shimEnv = {
  REEVAL_DOWNLOAD: download,
  XDG_CACHE_HOME: shimCache,
  UV_PYTHON: last,
  SMOKE_PYTHON: last,
}
const shim = sh('uv', ['run', 'reeval', 'run'], dir, shimEnv)
const name = basename(positionals[0])
check(
  `uv run reeval: the SDK downloads ${name}, checks it and runs the evals`,
  shim.status === 1 &&
    outcome(shim) === '1 fail · 2 pass' &&
    shim.out.includes(`downloading ${name}`) &&
    !shim.out.includes('SHA256SUMS only') &&
    existsSync(join(shimCache, 'reeval', 'bin', version, name)),
)
const offline = sh('uv', ['run', 'python', '-m', 'reeval_python', '--version'], dir, {
  ...shimEnv,
  REEVAL_OFFLINE: '1',
})
check(
  'python -m reeval_python, offline: the cached binary runs',
  offline.status === 0 && offline.stdout.trim() === version && !offline.out.includes('downloading'),
)

// pip, not uv: a venv seeded with pip, and reeval-python installed by it.
const bin = process.platform === 'win32' ? 'Scripts' : 'bin'
const exe = process.platform === 'win32' ? '.exe' : ''
function pipVenv(name, ...install) {
  const at = join(alone, name)
  sh('uv', ['venv', '--seed', '--python', last, at], alone)
  const python = join(at, bin, `python${exe}`)
  const pip = sh(python, ['-m', 'pip', 'install', '-q', '--no-index', ...install], alone)
  return { ok: pip.status === 0, python, reeval: join(at, bin, `reeval${exe}`) }
}
const pipPure = pipVenv('pip-pure', wheel)
const pureEnv = { REEVAL_DOWNLOAD: download, XDG_CACHE_HOME: join(alone, 'pip-cache') }
const pure = sh(pipPure.reeval, ['--version'], alone, pureEnv)
check(
  `pip install ${basename(wheel)}: reeval downloads ${name} for reeval-python's own version`,
  pipPure.ok &&
    pure.status === 0 &&
    pure.stdout.trim() === version &&
    pure.out.includes(`downloading ${name}`) &&
    !pure.out.includes('SHA256SUMS only'),
)

// The sdist, built into a wheel on install (hatchling from the index), records the same hashes.
if (values.sdist) {
  const sdist = resolve(values.sdist)
  const at = join(alone, 'pip-sdist')
  sh('uv', ['venv', '--python', last, at], alone)
  const built = sh('uv', ['pip', 'install', '-q', '--python', at, sdist], alone)
  const fromSdist = sh(join(at, bin, `reeval${exe}`), ['--version'], alone, {
    REEVAL_DOWNLOAD: download,
    XDG_CACHE_HOME: join(alone, 'sdist-cache'),
  })
  check(
    `pip install ${basename(sdist)}: reeval downloads ${name} and checks it against the recorded hash`,
    built.status === 0 &&
      fromSdist.status === 0 &&
      fromSdist.stdout.trim() === version &&
      fromSdist.out.includes(`downloading ${name}`) &&
      !fromSdist.out.includes('SHA256SUMS only'),
  )
}

// Ctrl-C through the launcher reaches reeval, which cancels the attempts and saves the run.
const stop = project('ctrl-c', '', wheel, 60_000)
const ctrlC = fileURLToPath(new URL('./ctrl-c.py', import.meta.url))
const stopped = sh(
  pipPure.python,
  [ctrlC, join('.reeval', 'staging', '*', 'live.json'), pipPure.reeval, 'run'],
  stop,
  { ...pureEnv, SMOKE_PYTHON: last },
)
// `results <run dir>/summary.md`, with the record at `<run dir>.json`.
const summary = stopped.out.match(/results (\S+)summary\.md/)?.[1]
let status
try {
  const record = `${resolve(stop, summary).replace(/[\\/]$/, '')}.json`
  status = JSON.parse(readFileSync(record, 'utf8')).status
} catch {}
check(
  'Ctrl-C on reeval run through the launcher: reeval saves the run as interrupted and exits 130',
  stopped.status === 130 &&
    stopped.out.includes('Interrupted: attempts') &&
    status === 'interrupted',
)

// The platform wheel carries the binary, so nothing is downloaded, even with an empty cache. CI
// builds them so they can be turned on; releases publish only the sdist and the pure wheel.
if (values['platform-wheel']) {
  const own = resolve(values['platform-wheel']).replaceAll('\\', '/')
  const ownEnv = { XDG_CACHE_HOME: join(alone, 'empty-cache'), REEVAL_OFFLINE: '1' }
  const bundled = project('bundled', 'reeval-python', own)
  const env = { ...ownEnv, UV_PYTHON: last, SMOKE_PYTHON: last }
  const r = sh('uv', ['run', 'reeval', 'run'], bundled, env)
  const v = sh('uv', ['run', 'reeval', '--version'], bundled, env)
  check(
    `uv run reeval from ${basename(own)}: its own binary, reeval ${version}, runs the evals, offline`,
    r.status === 1 &&
      outcome(r) === '1 fail · 2 pass' &&
      !r.out.includes('downloading') &&
      v.stdout.trim() === version,
  )

  // pip keeps the binary's exec bit only when the wheel marks it a regular file.
  const pip = pipVenv('pip-platform', own)
  const pv = sh(pip.reeval, ['--version'], alone, ownEnv)
  const pipProject = project('pip', '')
  const pr = sh(pip.reeval, ['run'], pipProject, { ...ownEnv, SMOKE_PYTHON: last })
  check(
    `pip install ${basename(own)}: its own binary runs the evals on the venv's Python, offline`,
    pip.ok && pv.stdout.trim() === version && pr.status === 1 && outcome(pr) === '1 fail · 2 pass',
  )

  const links = pipVenv(
    'pip-find-links',
    '--find-links',
    dirname(wheel),
    '--find-links',
    dirname(own),
    `reeval-python==${wheelVersion}`,
  )
  const picked = sh(
    links.python,
    ['-c', 'from reeval_python.cli import bundled; print(bundled().is_file())'],
    alone,
  )
  check(
    `pip install --find-links ${basename(dirname(wheel))} ${basename(dirname(own))}: pip picks the platform wheel`,
    links.ok && picked.stdout.trim() === 'True',
  )
}

const stopsClearly = (r) =>
  !r.error &&
  r.status === 2 &&
  /stopped before it said hello/.test(r.out) &&
  /uv add reeval-python/.test(r.out)

const old = project('old-sdk', 'reeval-python==0.10.0')
const mismatch = reeval(old, ['run'], { UV_PYTHON: last })
check(
  'reeval-python 0.10.0 (an older runner protocol) stops with how to install the right one',
  stopsClearly(mismatch) && /run evals with reeval run/.test(mismatch.out),
)

const none = project('no-sdk', '')
const missing = reeval(none, ['run'], { UV_PYTHON: last })
check(
  'a project without reeval-python stops with how to install it',
  stopsClearly(missing) && /No module named reeval_python/.test(missing.out),
)

rmSync(alone, { recursive: true, force: true, maxRetries: 5 })
if (failures.length) {
  console.error(`\nbinary-python-smoke: ${failures.length} failed: ${failures.join('; ')}`)
  process.exit(1)
}
console.log(
  `\nbinary-python-smoke: ${basename(binary)} runs *.eval.py on Python ${versions.join(', ')}`,
)
