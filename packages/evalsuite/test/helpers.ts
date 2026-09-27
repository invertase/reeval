import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AttemptRecord, EvalEntry, RunRecord, Stack } from '../src/history/types.ts'
import { startCapture } from './support/differential.ts'

export const pkgRoot = fileURLToPath(new URL('..', import.meta.url))
const cli = join(pkgRoot, 'dist/cli.js')

/** Every test's CLI runs and projects go under one fresh directory, removed when tests end. */
const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'es-test-')))
writeFileSync(join(tmpRoot, '.gitconfig-empty'), '')
process.on('exit', () => {
  if (!process.env.ES_TEST_KEEP) rmSync(tmpRoot, { recursive: true, force: true })
})

/** A fresh directory for one test, e.g. a checkout target next to a project. */
export const tempDir = (name: string) => mkdtempSync(join(tmpRoot, `${name}-`))

// What a spawned CLI (and the git it runs) may see of the parent's environment. CI variables,
// GITHUB_* refs, provider keys and the user's git config would otherwise change what it does.
const PASSTHROUGH = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'SystemRoot',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'ES_DEBUG',
]

/** The environment every spawned process in the tests starts from. */
export const baseEnv: NodeJS.ProcessEnv = {
  ...Object.fromEntries(PASSTHROUGH.flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : []))),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(tmpRoot, '.gitconfig-empty'),
  NO_COLOR: '1',
  ES_UI: 'plain',
}

export type Project = { dir: string; sandboxes: string }

/** Creates a throwaway ES project that resolves `evalsuite` to this package. */
export async function project(name: string, files: Record<string, string>): Promise<Project> {
  const dir = tempDir(name)
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  await symlink(pkgRoot, join(dir, 'node_modules/evalsuite'), 'dir')
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return { dir, sandboxes: join(dir, 'sandboxes') }
}

export const fakeConfig = (options: { harness?: string; judge?: string; extra?: string } = {}) => `
import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { fakeSandbox } from 'evalsuite/sandbox'
import { fakeJudge } from 'evalsuite/judge'
export default defineConfig({
  harness: fakeHarness(${options.harness ?? '{}'}),
  sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url).pathname }),
  judge: ${options.judge ?? '{ model: fakeJudge({ score: 0.9 }) }'},
  ${options.extra ?? ''}
})
`

export type CliRun = { code: number | null; stdout: string; stderr: string }

export type CliOptions = {
  /** Merged over `baseEnv`. */
  env?: NodeJS.ProcessEnv
  /** Called with all stdout so far on every chunk, until it returns true. */
  onOutput?: (stdout: string, pid: number) => boolean
  /** Kills the CLI's process group and fails after this long (default 60s). */
  timeoutMs?: number
}

export function runCli(
  cwd: string,
  args: string[] = ['run'],
  opts: CliOptions = {},
): Promise<CliRun> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const name = relative(tmpRoot, cwd).replace(/-[A-Za-z0-9]{6}(?=\/|$)/g, '')
  const capture = startCapture(cwd, args, name)
  return new Promise((resolve, reject) => {
    // Detached, so the tests can signal its whole process group as a terminal would.
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...baseEnv, ...opts.env },
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    let watching = !!opts.onOutput
    const timer = setTimeout(() => {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
      reject(new Error(`es ${args.join(' ')} took over ${timeoutMs}ms\n${stdout}\n${stderr}`))
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      stdout += d
      if (watching && child.pid) watching = !opts.onOutput?.(stdout, child.pid)
    })
    child.stderr.on('data', (d) => {
      stderr += d
    })
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      capture({ code, stdout, stderr }, [cwd, realpathSync(cwd), tmpRoot, pkgRoot])
      resolve({ code, stdout, stderr })
    })
  })
}

export type EvalView = EvalEntry & {
  error: AttemptRecord['error']
  trial: AttemptRecord
  /** The first attempt's image, from `stack.images`. */
  image: Stack['images'][number] | null
  /** A file of the run's artifact directory, by path inside it. */
  read(path: string): string
}
export type RunView = { run: RunRecord; dir: string; evals: EvalView[]; read(path: string): string }

const runsIn = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
    : []

/** The newest run in `.es/runs/` (scratch) or, with `history`, in that history folder. */
export function readRun(
  project: string,
  options: { back?: number; history?: string } = {},
): RunView {
  const folder = join(project, options.history ?? '.es/runs')
  const names = runsIn(folder)
  const name = names[names.length - 1 - (options.back ?? 0)]
  if (!name) throw new Error(`no run in ${folder}`)
  const run: RunRecord = JSON.parse(readFileSync(join(folder, name), 'utf8'))
  const dir = join(folder, run.runId)
  const read = (path: string) => readFileSync(join(dir, path), 'utf8')
  const evals = run.evals.map((e) => {
    const trial = e.attempts[0] as AttemptRecord
    const image = run.stack.images.find((i) => i.id === trial.imageId) ?? null
    return { ...e, error: trial.error, trial, image, read }
  })
  return { run, dir, evals, read }
}

export const recordedRuns = (project: string, history = 'evals/.history') =>
  runsIn(join(project, history)).map((f) => f.slice(0, -5))

export const liveSandboxes = (p: Project) =>
  existsSync(p.sandboxes) ? readdirSync(p.sandboxes).filter((f) => f.startsWith('es-sandbox-')) : []
