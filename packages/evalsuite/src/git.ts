import { resolve } from 'node:path'
import { run } from '@evalsuite/sandbox-docker/process'
import { redactSecrets } from './redact.ts'

export type GitResult = { code: number; stdout: Buffer; stderr: string }

export type GitOptions = { input?: string | Uint8Array; env?: NodeJS.ProcessEnv }

/** Runs git without a shell. Never include credentials in `args`; pass them through `env`. */
export async function git(
  cwd: string,
  args: string[],
  options: GitOptions = {},
): Promise<GitResult> {
  const r = await run('git', args, {
    cwd,
    env: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...options.env },
    input: options.input,
    detached: false,
    binary: true,
  })
  return { code: r.exitCode, stdout: r.stdout, stderr: redactSecrets(r.stderr) }
}

/**
 * The repository's top level, spelled from `root`: `--show-toplevel` resolves symlinks and
 * Windows 8.3 names (`RUNNER~1`), so a path relative to it can climb out of the repository.
 */
export async function repoTop(root: string): Promise<string | null> {
  const r = await git(root, ['rev-parse', '--show-cdup'])
  return r.code === 0 ? resolve(root, r.stdout.toString('utf8').trim()) : null
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
