import { spawn } from 'node:child_process'
import type { ExecResult } from '../types.ts'

/** Spawns a process and collects its output. Aborting kills it with SIGKILL. */
export function spawnCollect(
  cmd: string,
  args: string[],
  opts: { cwd?: string; signal?: AbortSignal; input?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(opts.signal.reason)
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: 'pipe' })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d
    })
    child.stderr.on('data', (d) => {
      stderr += d
    })
    const onAbort = () => child.kill('SIGKILL')
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', reject)
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (opts.signal?.aborted) return reject(opts.signal.reason)
      resolve({ exitCode: code ?? 1, stdout, stderr })
    })
    child.stdin.end(opts.input ?? '')
  })
}
