import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EvalEntry, RunIndex, RunRecord, TrialRecord } from '../src/record/types.ts'

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
  opts: { onSpawn?: (pid: number) => void } = {},
): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', CI: '' },
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
  error: TrialRecord['error']
  trial: TrialRecord
  /** A file of this eval's first trial, by path relative to the run directory. */
  read(path: string): string
}
export type RunView = { run: RunRecord; dir: string; evals: EvalView[]; read(path: string): string }

/** The newest run, found through `.es/index.json` like every other reader. */
export function readRun(project: string, back = 0): RunView {
  const index: RunIndex = JSON.parse(readFileSync(join(project, '.es/index.json'), 'utf8'))
  const entry = index.runs[index.runs.length - 1 - back]
  if (!entry) throw new Error('no run in .es/index.json')
  const dir = join(project, '.es', dirname(entry.path))
  const read = (path: string) => readFileSync(join(dir, path), 'utf8')
  const run: RunRecord = JSON.parse(read('run.json'))
  const evals = run.evals.map((e) => {
    const trial: TrialRecord = JSON.parse(read(e.trials[0]?.result.path ?? ''))
    return { ...e, error: trial.error, trial, read }
  })
  return { run, dir, evals, read }
}

export const liveSandboxes = (p: Project) =>
  existsSync(p.sandboxes) ? readdirSync(p.sandboxes).filter((f) => f.startsWith('es-sandbox-')) : []
