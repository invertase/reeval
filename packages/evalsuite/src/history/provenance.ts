import { hostname, userInfo } from 'node:os'
import { relative, sep } from 'node:path'
import { inCI } from '../env.ts'
import { git } from '../git.ts'
import { sha256, slugify } from '../ids.ts'
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
  if (!inCI(env)) {
    return { kind: 'local', hostHash: sha256(`evalsuite:${hostname()}`).slice(0, 12) }
  }
  if (env.GITHUB_ACTIONS) {
    const runUrl =
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : null
    const attempt = Number(env.GITHUB_RUN_ATTEMPT)
    // Pull request events check out refs/pull/<n>/merge and set the base branch.
    const number = Number(/^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? '')?.[1])
    const pr =
      number || env.GITHUB_BASE_REF
        ? { number: number || null, baseRef: env.GITHUB_BASE_REF || null }
        : null
    return { kind: 'ci', provider: 'github', runUrl, attempt: attempt || null, pr }
  }
  if (env.GITLAB_CI) {
    const iid = Number(env.CI_MERGE_REQUEST_IID)
    const pr = iid
      ? { number: iid, baseRef: env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME || null }
      : null
    return { kind: 'ci', provider: 'gitlab', runUrl: env.CI_JOB_URL ?? null, attempt: null, pr }
  }
  return { kind: 'ci', provider: 'unknown', runUrl: null, attempt: null, pr: null }
}

/** Who a run belongs to, as a file-name segment: `ci` in CI, else the git user. */
export async function author(root: string, env = process.env): Promise<string> {
  if (inCI(env)) return 'ci'
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
