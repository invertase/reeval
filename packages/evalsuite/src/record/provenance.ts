import { hostname } from 'node:os'
import { git } from '../git.ts'
import { sha256 } from '../ids.ts'
import { stripCredentials } from '../redact.ts'
import type { GitInfo, RunnerInfo } from './types.ts'

const text = async (cwd: string, args: string[]) => {
  const r = await git(cwd, args)
  return r.code === 0 ? r.stdout.toString('utf8').trim() : null
}

/** Porcelain paths are relative to the repo root; ES's own output never makes a run dirty. */
const isEsOutput = (path: string) => path.split('/').includes('.es')

/** The code under test. Null outside a git repo or before the first commit. */
export async function gitInfo(root: string, env = process.env): Promise<GitInfo | null> {
  const sha = await text(root, ['rev-parse', '--verify', '-q', 'HEAD'])
  if (!sha) return null
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const entries = status.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }))
    .filter((e) => e.path && !isEsOutput(e.path))
  const dirty = entries.length > 0
  let diffHash: string | null = null
  if (dirty) {
    const diff = await git(root, [
      'diff',
      'HEAD',
      '--binary',
      '--',
      '.',
      ':(exclude,glob)**/.es/**',
    ])
    const untracked = entries
      .filter((e) => e.code === '??')
      .map((e) => e.path)
      .sort()
    diffHash = sha256(Buffer.concat([diff.stdout, Buffer.from(`\0${untracked.join('\0')}`)]))
  }
  const branch =
    env.GITHUB_HEAD_REF ||
    env.GITHUB_REF_NAME ||
    env.CI_COMMIT_REF_NAME ||
    (await text(root, ['symbolic-ref', '--short', '-q', 'HEAD'])) ||
    null
  const remote = await text(root, ['remote', 'get-url', 'origin'])
  return {
    sha,
    branch,
    dirty,
    diffHash,
    commitTime: (await text(root, ['show', '-s', '--format=%cI', 'HEAD'])) ?? '',
    shallow: (await text(root, ['rev-parse', '--is-shallow-repository'])) === 'true',
    remote: remote ? stripCredentials(remote) : null,
  }
}

export function runnerInfo(env = process.env): RunnerInfo {
  if (!env.CI || env.CI === 'false') {
    return { kind: 'local', hostHash: sha256(`evalsuite:${hostname()}`).slice(0, 12) }
  }
  if (env.GITHUB_ACTIONS) {
    const runUrl =
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : null
    const attempt = Number(env.GITHUB_RUN_ATTEMPT)
    return { kind: 'ci', provider: 'github', runUrl, attempt: attempt || null }
  }
  if (env.GITLAB_CI) {
    return { kind: 'ci', provider: 'gitlab', runUrl: env.CI_JOB_URL ?? null, attempt: null }
  }
  return { kind: 'ci', provider: 'unknown', runUrl: null, attempt: null }
}
