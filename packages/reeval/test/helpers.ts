import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawn,
  spawnSync,
} from 'node:child_process'
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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { killTree, windowsSpawn } from '@reeval/sandbox-docker/process'
import type { AttemptRecord, EvalEntry, RunRecord, Stack } from '../src/history/types.ts'

export const pkgRoot = fileURLToPath(new URL('..', import.meta.url))
const cli = join(pkgRoot, 'dist/cli.js')

/** Every test's CLI runs and projects go under one fresh directory, removed when tests end. */
const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'reeval-test-')))
writeFileSync(join(tmpRoot, '.gitconfig-empty'), '')
process.on('exit', () => {
  if (process.env.REEVAL_TEST_KEEP) return
  try {
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 })
  } catch (error) {
    // Windows refuses (EPERM) while a process a test killed still holds a file under it.
    process.stderr.write(`warning: left ${tmpRoot}: ${(error as Error).message}\n`)
  }
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
  'REEVAL_DEBUG',
  // Windows: where programs, the user's profile and app data are, and how a shell finds commands.
  'PATHEXT',
  'ComSpec',
  'windir',
  'SystemDrive',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramData',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
]

/**
 * Runs a command-line tool by name. npm, pnpm, yarn, corepack and npx are `.cmd` scripts on
 * Windows, which only cmd.exe runs, so there it goes the way reeval's own `run` does.
 */
export function spawnTool(
  cmd: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
  if (process.platform !== 'win32') return spawnSync(cmd, args, options)
  const target = windowsSpawn(cmd, args, { ...process.env, ...options.env })
  return spawnSync(target.file, target.args, {
    ...options,
    windowsVerbatimArguments: target.verbatim,
  })
}

/**
 * Why a test that sends the CLI Ctrl-C or SIGTERM can't run: Windows has no signals to send, and
 * `process.kill(pid, 'SIGINT')` terminates the process outright. Cleanup when the CLI dies is
 * still tested there, through the worker's IPC channel closing (the main process SIGKILL test).
 */
export const noSignals =
  process.platform === 'win32' &&
  "Windows can't send a process SIGINT or SIGTERM: process.kill terminates it instead"

/** The environment every spawned process in the tests starts from. */
export const baseEnv: NodeJS.ProcessEnv = {
  ...Object.fromEntries(PASSTHROUGH.flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : []))),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(tmpRoot, '.gitconfig-empty'),
  NO_COLOR: '1',
  REEVAL_UI: 'plain',
  // The dry run's cost estimate would fetch models.dev; a test that wants prices supplies a file.
  REEVAL_PRICES: 'none',
}

export type Project = { dir: string; sandboxes: string }

/** Creates a throwaway reeval project that resolves `reeval` to this package. */
export async function project(name: string, files: Record<string, string>): Promise<Project> {
  const dir = tempDir(name)
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  await symlink(pkgRoot, join(dir, 'node_modules/reeval'), 'dir')
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return { dir, sandboxes: join(dir, 'sandboxes') }
}

export const fakeConfig = (options: { harness?: string; judge?: string; extra?: string } = {}) => `
import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { fakeJudge } from 'reeval/judge'
const sandbox = fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) })
export default defineConfig({
  harness: fakeHarness(${options.harness ?? '{}'}),
  sandbox,
  environment: defineEnvironment('fake', {}),
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
  /**
   * Stops the CLI when it goes this long with no stdout or stderr (default 60s). A slow host that
   * still prints is not treated as hung, and neither is a stuck `reeval run`, whose heartbeat
   * prints: `deadlineMs` bounds that.
   */
  timeoutMs?: number
  /** Stops the CLI when it has run this long, output or not. */
  deadlineMs?: number
  /** Aborting stops the CLI, e.g. a test's `t.signal`, which aborts when the test times out. */
  signal?: AbortSignal
  /** How long a stopped CLI has to cancel its run and remove its sandboxes before SIGKILL (20s). */
  graceMs?: number
}

/**
 * Runs the CLI. Stopping it (`timeoutMs`, `deadlineMs`, `signal`) sends SIGTERM to its process
 * group, as a CI runner's cancel does, so it cancels the run and removes its sandboxes; SIGKILL
 * follows after `graceMs`. The promise rejects once the CLI has exited, with why it was stopped
 * and its output so far, so nothing it started outlives the call.
 */
export function runCli(
  cwd: string,
  args: string[] = ['run'],
  opts: CliOptions = {},
): Promise<CliRun> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    // Detached, so the tests can signal its whole process group as a terminal would. Not on
    // Windows, which stops it with killTree and where detached gives each CLI its own console:
    // dozens at once can leave one alive long after it has printed everything.
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...baseEnv, ...opts.env },
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let watching = !!opts.onOutput
    let stopped: string | null = null
    let idle: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let kill: ReturnType<typeof setTimeout> | undefined
    const clear = () => {
      clearTimeout(idle)
      clearTimeout(deadline)
      clearTimeout(kill)
      opts.signal?.removeEventListener('abort', onAbort)
    }
    const stop = (why: string) => {
      if (stopped !== null || !child.pid) return
      stopped = why
      clearTimeout(idle)
      clearTimeout(deadline)
      if (process.platform === 'win32') return killTree(child.pid)
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {}
      const pid = child.pid
      kill = setTimeout(() => killTree(pid), opts.graceMs ?? 20_000)
    }
    const onAbort = () => stop('the test was cancelled (it timed out, or a sibling failed)')
    const arm = () => {
      clearTimeout(idle)
      if (stopped === null) {
        idle = setTimeout(() => stop(`it produced no output for ${timeoutMs}ms`), timeoutMs)
      }
    }
    arm()
    if (opts.deadlineMs !== undefined) {
      const ms = opts.deadlineMs
      deadline = setTimeout(() => stop(`it was still running after ${ms}ms`), ms)
    }
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      stdout += d
      arm()
      if (watching && child.pid) watching = !opts.onOutput?.(stdout, child.pid)
    })
    child.stderr.on('data', (d) => {
      stderr += d
      arm()
    })
    child.on('error', (error) => {
      clear()
      reject(error)
    })
    child.on('close', (code, signal) => {
      clear()
      if (stopped === null) return resolve({ code, stdout, stderr })
      const exit = signal ?? `exit ${code}`
      reject(
        new Error(
          `reeval ${args.join(' ')} was stopped because ${stopped}; it exited (${exit}) ${Date.now() - startedAt}ms after it started\n${stdout}\n${stderr}`,
        ),
      )
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

/** The newest run in `.reeval/runs/` (scratch) or, with `history`, in that history folder. */
export function readRun(
  project: string,
  options: { back?: number; history?: string } = {},
): RunView {
  const folder = join(project, options.history ?? '.reeval/runs')
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
  existsSync(p.sandboxes)
    ? readdirSync(p.sandboxes).filter((f) => f.startsWith('reeval-sandbox-'))
    : []
