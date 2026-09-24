import { spawn } from 'node:child_process'
import { redactSecrets } from './redact.ts'

export type GitResult = { code: number; stdout: Buffer; stderr: string }

export type GitOptions = { input?: string | Uint8Array; env?: NodeJS.ProcessEnv }

/** Runs git without a shell. Never include credentials in `args`; pass them through `env`. */
export function git(cwd: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => {
      stderr += d
    })
    child.on('error', reject)
    child.on('close', (code) =>
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: redactSecrets(stderr) }),
    )
    child.stdin.on('error', () => {})
    child.stdin.end(options.input ?? '')
  })
}

export class GitError extends Error {
  override name = 'GitError'
}

/** Runs git and returns trimmed stdout, or throws with git's (redacted) stderr. */
export async function gitText(cwd: string, args: string[], options?: GitOptions): Promise<string> {
  const r = await git(cwd, args, options)
  if (r.code !== 0) throw new GitError(`git ${args[0]} failed: ${r.stderr.trim()}`)
  return r.stdout.toString('utf8').trim()
}
