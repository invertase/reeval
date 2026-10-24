// The launcher conformance suite: runs every case in cases.json and every row of targets.json
// against one language's `reeval` launcher, pointed at a fake release server.
//
//   node --experimental-strip-types test/conformance/launcher/run.ts <runner>
//
// <runner> is a module in runners/ (python, …). It needs Go, to build the fake binary.
import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import type { Facts, Launcher, Released, Runner } from './runner.ts'
import {
  deadPort,
  type Mode,
  type ReleaseServer,
  sha256,
  startReleaseServer,
  WRONG_SHA256,
} from './server.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../../../..')
const windows = process.platform === 'win32'

type Expect = {
  exit: number
  ran?: boolean
  stderr?: string[]
  stdout?: string[]
  quiet?: boolean
  env?: { [name: string]: string }
  cache?: 'binary' | 'absent'
  downloads?: number
  httpRequests?: number
}
type Step = {
  release: Mode | 'unreachable'
  env?: { [name: string]: string }
  args?: string[]
  parallel?: number
  interrupt?: 'ctrl-c' | 'sigterm'
  timeout?: number
  expect: Expect
}
type Case = {
  id: string
  about: string
  version?: string
  https?: boolean
  only?: 'posix' | 'windows'
  needs?: 'interpreterEnv'
  seed?: 'binary' | 'empty' | 'junk' | 'garbage'
  record?: 'match' | 'wrong' | 'no-target'
  steps: Step[]
}
type Suite = { version: string; env: { [name: string]: string }; cases: Case[] }
type Row = { facts: Facts; target?: string; exit?: number }
type Result = { code: number | null; signal: string | null; stdout: string; stderr: string }

const suite: Suite = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'))
const rows: Row[] = JSON.parse(readFileSync(join(here, 'targets.json'), 'utf8')).rows

const name = process.argv[2] ?? process.env.REEVAL_LAUNCHER_RUNNER
if (!name) throw new Error('usage: run.ts <runner>, one of the modules in runners/')
const runner: Runner = (await import(pathToFileURL(join(here, 'runners', `${name}.ts`)).href))
  .default

/** The release target this machine should get, decided here independently of any launcher. */
function hostTarget(): string {
  if (process.env.REEVAL_CONFORMANCE_TARGET) return process.env.REEVAL_CONFORMANCE_TARGET
  const arch = { x64: 'x64', arm64: 'arm64' }[process.arch as string]
  if (!arch) throw new Error(`no reeval target for ${process.arch}; set REEVAL_CONFORMANCE_TARGET`)
  if (process.platform === 'darwin') return `darwin-${arch}`
  if (process.platform === 'win32') {
    const avx2 = execFileSync(
      'pwsh',
      ['-NoProfile', '-Command', '[System.Runtime.Intrinsics.X86.Avx2]::IsSupported'],
      { encoding: 'utf8' },
    ).trim()
    return avx2 === 'True' ? 'windows-x64' : 'windows-x64-baseline'
  }
  if (process.platform !== 'linux') throw new Error(`no reeval target for ${process.platform}`)
  const header = (process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header
  let target = `linux-${arch}${header.glibcVersionRuntime ? '' : '-musl'}`
  if (arch === 'x64' && !/\bavx2\b/.test(readFileSync('/proc/cpuinfo', 'utf8'))) {
    target += '-baseline'
  }
  return target
}

const assetName = (version: string, target: string) =>
  `reeval-${version}-${target}${target.startsWith('windows') ? '.exe' : ''}`

let tmp: string
let server: ReleaseServer
let launcher: Launcher
let fake: string
let binary: Buffer
const target = hostTarget()

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'reeval-launcher-'))
  fake = join(tmp, windows ? 'fake-reeval.exe' : 'fake-reeval')
  execFileSync('go', ['build', '-o', fake, 'main.go'], {
    cwd: join(here, 'fake-reeval'),
    env: { ...process.env, CGO_ENABLED: '0', GO111MODULE: 'off' },
    stdio: 'inherit',
  })
  binary = readFileSync(fake)
  server = await startReleaseServer(tmp)
  mkdirSync(join(tmp, 'launcher'))
  launcher = await runner.setup(join(tmp, 'launcher'))
})

after(async () => {
  await runner.record?.(null)
  await server?.close()
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
})

function released(version: string, kind: Case['record']): Released | null {
  if (!kind) return null
  const entry = (t: string) => ({
    name: assetName(version, t),
    sha256: kind === 'wrong' ? WRONG_SHA256 : sha256(binary),
    size: binary.length,
  })
  const other = target === 'darwin-arm64' ? 'linux-arm64' : 'darwin-arm64'
  return {
    version,
    binaries:
      kind === 'no-target'
        ? { [other]: entry(other) }
        : { [target]: entry(target), [other]: entry(other) },
  }
}

function fill(text: string, vars: { [name: string]: string }): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = vars[key]
    if (value === undefined) throw new Error(`cases.json names an unknown placeholder {${key}}`)
    return value
  })
}

const fillAll = (values: { [name: string]: string }, vars: { [name: string]: string }) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [fill(k, vars), fill(v, vars)]))

async function waitFor(file: string, child: { exitCode: number | null }) {
  for (let i = 0; i < 300 && child.exitCode === null; i++) {
    if (existsSync(file)) return
    await sleep(100)
  }
  throw new Error(`${file} never appeared`)
}

function run(
  step: Step,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  ready: string,
): Promise<Result> {
  const ctrlC = step.interrupt === 'ctrl-c'
  const [command, ...rest] =
    ctrlC && windows
      ? ['python', join(root, 'scripts', 'ctrl-c.py'), ready, ...launcher.command, ...args]
      : [...launcher.command, ...args]
  const child = spawn(command as string, rest, {
    env,
    cwd,
    detached: ctrlC && !windows,
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const kill = () => {
    try {
      if (ctrlC && !windows && child.pid) process.kill(-child.pid, 'SIGKILL')
      else child.kill('SIGKILL')
    } catch {}
  }
  const timer = setTimeout(kill, (step.timeout ?? 60) * 1000)
  const done = new Promise<Result>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
  if (step.interrupt && !(ctrlC && windows)) {
    waitFor(ready, child)
      .then(() => sleep(200))
      .then(() => {
        if (ctrlC && child.pid) process.kill(-child.pid, 'SIGINT')
        else child.kill('SIGTERM')
      })
      .catch(kill)
  }
  return done
}

function check(
  results: Result[],
  step: Step,
  args: string[],
  vars: { [name: string]: string },
  requests: string[],
  asset: string,
): string[] {
  const failures: string[] = []
  const expect = step.expect
  for (const [i, r] of results.entries()) {
    const who = results.length > 1 ? `run ${i + 1}: ` : ''
    const show = () =>
      `\n    stdout: ${JSON.stringify(r.stdout)}\n    stderr: ${JSON.stringify(r.stderr)}`
    const fail = (why: string) => failures.push(`${who}${why}${show()}`)
    if (r.code !== expect.exit) {
      fail(`exited ${r.code ?? `by ${r.signal}`}, expected ${expect.exit}`)
    }
    for (const want of expect.stderr ?? []) {
      const text = fill(want, vars)
      if (!r.stderr.includes(text)) fail(`stderr doesn't say ${JSON.stringify(text)}`)
    }
    for (const want of expect.stdout ?? []) {
      if (!r.stdout.includes(want)) fail(`stdout doesn't say ${JSON.stringify(want)}`)
    }
    if (expect.quiet && r.stderr.trim() !== '') fail("stderr isn't empty")
    if (!step.interrupt) {
      const stray = r.stderr.split(/\r?\n/).filter((l) => l && !l.startsWith('reeval: '))
      if (stray.length) fail(`stderr has lines not prefixed "reeval: ": ${JSON.stringify(stray)}`)
    }
    const lines = r.stdout.split(/\r?\n/).filter(Boolean)
    if (expect.ran === false && r.stdout !== '')
      fail('the binary ran, or the launcher wrote to stdout')
    if (expect.ran || expect.env) {
      let report: { fake?: string; argv?: string[]; env?: { [k: string]: string } } = {}
      try {
        report = JSON.parse(lines[0] ?? '')
      } catch {}
      if (report.fake !== 'reeval') fail("the binary didn't run (no report on stdout's first line)")
      else {
        if (expect.ran && lines.length !== 1) fail("stdout has more than the binary's report")
        if (!isDeepStrictEqual(report.argv, args)) {
          fail(`the binary got ${JSON.stringify(report.argv)}, not ${JSON.stringify(args)}`)
        }
        for (const [key, value] of Object.entries(fillAll(expect.env ?? {}, vars))) {
          const got = report.env?.[key]
          if (value === '*' ? !got : got !== value) {
            fail(
              `the binary got ${key}=${JSON.stringify(got)}, expected ${value === '*' ? 'it set' : JSON.stringify(value)}`,
            )
          }
        }
      }
    }
  }
  const cachePath = vars.cachePath as string
  if (expect.cache === 'absent' && existsSync(cachePath)) failures.push(`${cachePath} exists`)
  if (expect.cache === 'binary') {
    if (!existsSync(cachePath)) failures.push(`${cachePath} doesn't exist`)
    else {
      if (sha256(readFileSync(cachePath)) !== sha256(binary)) {
        failures.push(`${cachePath} isn't the released binary`)
      }
      if (!windows && !(statSync(cachePath).mode & 0o100)) {
        failures.push(`${cachePath} isn't executable`)
      }
    }
  }
  const dir = dirname(cachePath)
  if (existsSync(dir)) {
    const allowed = new Set([asset, ...(runner.sidecars ?? []).map((s) => asset + s)])
    const stray = readdirSync(dir).filter((f) => !allowed.has(f))
    if (stray.length) failures.push(`the cache has files besides the binary: ${stray.join(', ')}`)
  }
  const fetched = requests.filter((r) => r.endsWith(` /r/${asset}`) || r.endsWith(` /s/${asset}`))
  if (expect.downloads !== undefined && fetched.length !== expect.downloads) {
    failures.push(`downloaded the asset ${fetched.length} times, expected ${expect.downloads}`)
  }
  const plain = requests.filter((r) => r.startsWith('http '))
  if (expect.httpRequests !== undefined && plain.length !== expect.httpRequests) {
    failures.push(
      `made ${plain.length} plain http requests (${plain.join(', ')}), expected ${expect.httpRequests}`,
    )
  }
  return failures
}

async function runCase(c: Case): Promise<string[]> {
  const version = c.version ?? suite.version
  const asset = assetName(version, target)
  const work = mkdtempSync(join(tmp, `${c.id}-`))
  const cache = join(work, 'cache')
  const cachePath = join(cache, 'reeval', 'bin', version, asset)
  const release = join(work, 'release')
  mkdirSync(release)
  writeFileSync(join(release, asset), binary)
  writeFileSync(join(release, 'SHA256SUMS'), `${sha256(binary)} *${asset}\n`)
  const vars: { [name: string]: string } = {
    version,
    target,
    asset,
    cachePath,
    sha256: sha256(binary),
    wrongSha256: WRONG_SHA256,
    fake,
    launcher: launcher.file,
    ready: join(work, 'ready'),
    work,
    missing: join(work, 'no-such-reeval'),
    httpBase: server.http,
    fileBase: pathToFileURL(release).href,
    interpreterEnv: runner.interpreterEnv ?? 'REEVAL_NO_INTERPRETER',
  }
  if (c.seed) {
    mkdirSync(dirname(cachePath), { recursive: true })
    const bytes = {
      binary,
      empty: Buffer.alloc(0),
      junk: Buffer.from('#!/bin/sh\nexit 0\n'),
      garbage: Buffer.from('\0\x01 not an executable\n'),
    }[c.seed]
    writeFileSync(cachePath, bytes)
    chmodSync(cachePath, 0o755)
  }
  await runner.record?.(released(version, c.record))
  const failures: string[] = []
  for (const [i, step] of c.steps.entries()) {
    const unreachable = step.release === 'unreachable'
    const base = unreachable
      ? `http://127.0.0.1:${await deadPort()}/r`
      : c.https
        ? server.https
        : server.http
    const stepVars = { ...vars, base }
    server.set({ mode: unreachable ? 'missing' : step.release, asset, binary })
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith('REEVAL_') && k !== 'VIRTUAL_ENV') env[k] = v
    }
    Object.assign(
      env,
      { XDG_CACHE_HOME: cache },
      c.https ? runner.trust?.(server.caFile) : {},
      fillAll({ ...suite.env, ...step.env }, stepVars),
    )
    const args = (step.args ?? ['run']).map((a) => fill(a, stepVars))
    rmSync(stepVars.ready as string, { force: true })
    const results = await Promise.all(
      Array.from({ length: step.parallel ?? 1 }, () =>
        run(step, args, env, work, stepVars.ready as string),
      ),
    )
    const stepFailures = check(results, step, args, stepVars, [...server.requests], asset)
    failures.push(...stepFailures.map((f) => (c.steps.length > 1 ? `step ${i + 1}: ${f}` : f)))
    if (stepFailures.length) break
  }
  return failures
}

for (const c of suite.cases) {
  const skip =
    (c.only === 'posix' && windows) || (c.only === 'windows' && !windows)
      ? `${c.only} only`
      : c.https && !runner.trust
        ? `the ${runner.name} runner can't make its launcher trust a test CA`
        : c.record && !runner.record
          ? `the ${runner.name} runner can't set the launcher's recorded hashes`
          : c.needs && !runner[c.needs]
            ? `the ${runner.name} runner has no ${c.needs}`
            : false
  test(`${c.id}: ${c.about}`, { skip }, async (t) => {
    const failures = await runCase(c)
    const divergence = runner.divergences?.[c.id]
    if (divergence) {
      if (!failures.length) {
        throw new Error(
          `${c.id} is listed as a divergence of the ${runner.name} launcher, but passes`,
        )
      }
      t.todo(`known divergence: ${divergence}`)
    }
    if (failures.length) throw new Error(failures.join('\n'))
  })
}

test('target pick', {
  skip: runner.pickTargets ? false : `the ${runner.name} runner has no pickTargets`,
}, async (t) => {
  const picked = await runner.pickTargets?.(rows.map((r) => r.facts))
  const divergence = runner.divergences?.['target-pick']
  const failures = rows.flatMap((row, i) => {
    const got = picked?.[i]
    const want = row.target ? { target: row.target } : { exit: row.exit }
    const ok = got && ('target' in got ? got.target === row.target : got.exit === row.exit)
    return ok
      ? []
      : [
          `${JSON.stringify(row.facts)}: picked ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
        ]
  })
  if (divergence) {
    if (!failures.length)
      throw new Error(
        `target-pick is listed as a divergence of the ${runner.name} launcher, but passes`,
      )
    t.todo(`known divergence: ${divergence}`)
  }
  if (failures.length) throw new Error(failures.join('\n'))
})
