import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AttemptRecord, EvalEntry, RunRecord } from '../src/history/types.ts'

export const pkgRoot = fileURLToPath(new URL('..', import.meta.url))
const cli = join(pkgRoot, 'dist/cli.js')
const tmpRoot = join(pkgRoot, 'test/.tmp')

export type Project = { dir: string; sandboxes: string }

/** Creates a throwaway ES project that resolves `evalsuite` to this package. */
export async function project(name: string, files: Record<string, string>): Promise<Project> {
  const dir = join(tmpRoot, name)
  await rm(dir, { recursive: true, force: true })
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

export function runCli(
  cwd: string,
  args: string[] = ['run'],
  opts: { onSpawn?: (pid: number) => void; env?: NodeJS.ProcessEnv } = {},
): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', CI: '', ...opts.env },
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d
    })
    child.stderr.on('data', (d) => {
      stderr += d
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    if (child.pid) opts.onSpawn?.(child.pid)
  })
}

export type EvalView = EvalEntry & {
  error: AttemptRecord['error']
  trial: AttemptRecord
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
    return { ...e, error: trial.error, trial, read }
  })
  return { run, dir, evals, read }
}

export const recordedRuns = (project: string, history = 'evals/.history') =>
  runsIn(join(project, history)).map((f) => f.slice(0, -5))

export const liveSandboxes = (p: Project) =>
  existsSync(p.sandboxes) ? readdirSync(p.sandboxes).filter((f) => f.startsWith('es-sandbox-')) : []
