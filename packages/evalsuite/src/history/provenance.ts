import { hostname, userInfo } from 'node:os'
import { relative, sep } from 'node:path'
import { git } from '../git.ts'
import { randomSuffix, sha256, slugify } from '../ids.ts'
import { stripCredentials } from '../redact.ts'
import type { GitInfo, RunnerInfo } from './types.ts'

const text = async (cwd: string, args: string[]) => {
  const r = await git(cwd, args)
  return r.code === 0 ? r.stdout.toString('utf8').trim() : null
}

/**
 * The code under test. Null outside a git repo or before the first commit. ES's own output
 * (`.es/` and the history folder, given in `ignore` as absolute paths) never makes a run dirty.
 */
export async function gitInfo(
  root: string,
  ignore: string[] = [],
  env = process.env,
): Promise<GitInfo | null> {
  const sha = await text(root, ['rev-parse', '--verify', '-q', 'HEAD'])
  if (!sha) return null
  const top = (await text(root, ['rev-parse', '--show-toplevel'])) ?? root
  const ignored = ignore.map((dir) => `${relative(top, dir).split(sep).join('/')}/`)
  const isEsOutput = (path: string) =>
    path.split('/').includes('.es') || ignored.some((dir) => path.startsWith(dir))
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const entries = status.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }))
    .filter((e) => e.path && !isEsOutput(e.path))
  const dirty = entries.length > 0
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
    // Filled in with worktree.patch when the run is assembled.
    diffHash: null,
    worktreePatch: null,
    worktreePatchNote: null,
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

/**
 * Who a run belongs to, as a file-name segment. CI runs get a random suffix so parallel jobs on
 * the same commit and second can never produce the same file name.
 */
export async function author(root: string, env = process.env): Promise<string> {
  if (env.CI && env.CI !== 'false') return `ci-${randomSuffix(4)}`
  const name = await text(root, ['config', 'user.name'])
  const email = await text(root, ['config', 'user.email'])
  let user = ''
  try {
    user = userInfo().username
  } catch {}
  for (const candidate of [name, email?.split('@')[0], user]) {
    const slug = candidate ? slugify(candidate, 24) : ''
    if (slug) return slug
  }
  return 'unknown'
}
