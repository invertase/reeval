import { shellQuote } from '@reeval/sandbox-docker/process'
import type { Sandbox } from './sandbox/types.ts'
import { InfraError } from './sandbox/types.ts'
import type { Diff, FileChange } from './types.ts'

const GIT = 'git -c user.name=reeval -c user.email=reeval@localhost -c core.hooksPath=/dev/null'
const SNAPSHOT_ENV = 'export GIT_DIR="$PWD/../.reeval-git-$(basename "$PWD")" GIT_WORK_TREE="$PWD"'

/** Records the workspace state before the agent runs, in a git dir outside the workspace. */
export async function snapshot(sandbox: Sandbox, signal?: AbortSignal): Promise<void> {
  const r = await sandbox.exec(
    `${SNAPSHOT_ENV} && ${GIT} init -q && ${GIT} add -A && ${GIT} commit -q --allow-empty -m base`,
    { signal },
  )
  if (r.exitCode !== 0) throw new InfraError(`Failed to snapshot the workspace: ${r.stderr.trim()}`)
}

/**
 * Moves the snapshot forward for one workspace file as it is now, so later diffs show only
 * changes made to it after this. Only that path is committed: the other changes stay in the
 * diff. `-f` tracks a file the workspace's `.gitignore` covers, so a later edit to it shows too.
 */
export async function acceptIntoSnapshot(
  sandbox: Sandbox,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  const quoted = shellQuote(path)
  const r = await sandbox.exec(
    `${SNAPSHOT_ENV} && export GIT_LITERAL_PATHSPECS=1 && ${GIT} add -f -- ${quoted} && ` +
      `${GIT} commit -q --allow-empty --no-verify -m ${shellQuote(`place ${path}`)} --only -- ${quoted}`,
    { signal },
  )
  if (r.exitCode !== 0) {
    throw new InfraError(`Failed to keep ${path} out of the diff: ${r.stderr.trim()}`)
  }
}

export async function diffSinceSnapshot(sandbox: Sandbox, signal?: AbortSignal): Promise<Diff> {
  const env = `${SNAPSHOT_ENV} && ${GIT} add -A && `
  const patch = await sandbox.exec(`${env}${GIT} diff --cached --binary HEAD`, { signal })
  const names = await sandbox.exec(`${env}${GIT} diff --cached --name-status --no-renames HEAD`, {
    signal,
  })
  if (patch.exitCode !== 0 || names.exitCode !== 0) {
    throw new InfraError(`Failed to diff the workspace: ${patch.stderr || names.stderr}`)
  }
  const status = { A: 'added', M: 'modified', D: 'deleted' } as const
  const files = names.stdout
    .split('\n')
    .filter(Boolean)
    .map((line): FileChange => {
      const [code = 'M', ...rest] = line.split('\t')
      return { path: rest.join('\t'), status: status[code[0] as keyof typeof status] ?? 'modified' }
    })
  return { patch: patch.stdout, files }
}

/** Every file in the workspace as git sees it (its `.gitignore` applies), sorted. */
export async function workspaceFiles(sandbox: Sandbox, signal?: AbortSignal): Promise<string[]> {
  const r = await sandbox.exec(`${SNAPSHOT_ENV} && ${GIT} add -A && ${GIT} ls-files -z`, { signal })
  if (r.exitCode !== 0)
    throw new InfraError(`Failed to list the workspace's files: ${r.stderr.trim()}`)
  return r.stdout.split('\0').filter(Boolean).sort()
}
