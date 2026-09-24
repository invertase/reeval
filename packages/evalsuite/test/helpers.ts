import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EsResult } from '../src/types.ts'

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
export default defineConfig({
  harness: fakeHarness(${options.harness ?? '{}'}),
  sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url).pathname }),
  judge: ${options.judge ?? "{ fake: { verdict: 'pass', reason: 'ok', evidence: ['e'] } }"},
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

export function readResult(dir: string): EsResult {
  const results = join(dir, '.es/results')
  const [runId] = readdirSync(results).sort().reverse()
  if (!runId) throw new Error('no result directory')
  return JSON.parse(readFileSync(join(results, runId, 'result.json'), 'utf8'))
}

export const liveSandboxes = (p: Project) =>
  existsSync(p.sandboxes) ? readdirSync(p.sandboxes).filter((f) => f.startsWith('es-sandbox-')) : []
