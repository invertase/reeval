// Smoke-tests a compiled reeval running Python evals on the machine it was built for, with only
// the binary and uv: no Node project, no reeval-python on the machine. binary.yml runs it on each OS.
//
//   node scripts/binary-python-smoke.mjs <binary> --wheel <reeval_python-*.whl> [--python 3.11,3.14]
//
// In an empty directory it writes a project with a reeval.yml and a pyproject.toml that depends on
// the wheel (built from the same commit as the binary). For each Python version it runs three
// *.eval.py files on the fake harness and sandbox: one judge-free (it also checks the runner's Python is that version),
// one with the fake judge, and a canary that must fail. Then it runs the project from its .venv
// with no pyproject.toml, so reeval starts .venv's python rather than uv, and checks that a
// reeval-python too old for the binary (0.10.0, from PyPI) and a project without reeval-python
// both stop with how to install it rather than hang.
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs, stripVTControlCharacters } from 'node:util'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    wheel: { type: 'string' },
    python: { type: 'string', default: '3.11,3.12,3.13,3.14' },
  },
})
if (positionals.length !== 1 || !values.wheel) {
  console.error('usage: node scripts/binary-python-smoke.mjs <binary> --wheel <whl> [--python …]')
  process.exit(2)
}
const versions = values.python.split(',').map((v) => v.trim())
const wheel = resolve(values.wheel).replaceAll('\\', '/')
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

// reeval.yml, not reeval.config.ts: a Python project has no TypeScript.
const CONFIG = `include: ['evals/**/*.eval.py']
harness: { kind: fake, files: { greet.py: "print(\\"hi\\")\\n" }, text: I wrote greet.py. }
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

function project(name, dependency) {
  const dir = join(alone, name)
  mkdirSync(join(dir, 'evals'), { recursive: true })
  writeFileSync(join(dir, 'reeval.yml'), CONFIG)
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
        ? ['', '[tool.uv.sources]', `reeval-python = { path = '${wheel}' }`]
        : []),
      '',
    ].join('\n'),
  )
  return dir
}

function reeval(cwd, args, env = {}) {
  const started = performance.now()
  const r = spawnSync(binary, args, {
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
      .join('')}reeval ${args.join(' ')}  (${how}, ${seconds}s)`,
  )
  const out = stripVTControlCharacters(`${r.stdout ?? ''}${r.stderr ?? ''}`).trimEnd()
  console.log(args.includes('--json') ? `${out.slice(0, 300)}…` : out)
  return { ...r, out }
}
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
