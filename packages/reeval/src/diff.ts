import { shellQuote } from '@reeval/sandbox-docker/process'
import type { Sandbox } from './sandbox/types.ts'
import { InfraError } from './sandbox/types.ts'
import type { Diff, FileChange } from './types.ts'

// No reflog and no automatic gc: `prune` then removes every object HEAD and the index don't
// reach, and nothing is ever packed where a loose-object prune can't remove it.
const GIT =
  'git -c user.name=reeval -c user.email=reeval@localhost -c core.hooksPath=/dev/null' +
  ' -c core.logAllRefUpdates=false -c gc.auto=0'

const snapshotEnv = (sandbox: Sandbox) =>
  `export GIT_DIR=${shellQuote(`${sandbox.stateDir}/workspace.git`)} GIT_WORK_TREE="$PWD"`

/** Points HEAD at a commit of `$tree` with no parent, then drops every object nothing reaches. */
const RESET_HEAD = `c=$(${GIT} commit-tree -m base "$tree") && ${GIT} update-ref HEAD "$c" && ${GIT} prune --expire=now`

/**
 * Records the workspace state before the agent runs, in a git dir in the sandbox's state
 * directory, outside the workspace.
 */
export async function snapshot(sandbox: Sandbox, signal?: AbortSignal): Promise<void> {
  const r = await sandbox.execOwn(
    `${snapshotEnv(sandbox)} && ${GIT} init -q && ${GIT} add -A && tree=$(${GIT} write-tree) && ${RESET_HEAD}`,
    { signal },
  )
  if (r.exitCode !== 0) throw new InfraError(`Failed to snapshot the workspace: ${r.stderr.trim()}`)
}

/**
 * Moves the snapshot forward for one workspace file as it is now, so later diffs show only
 * changes made to it after this. Only that path moves: the other changes stay in the diff. `-f`
 * tracks a file the workspace's `.gitignore` covers, so a later edit to it shows too. The
 * snapshot stays one commit, and what the file was before is pruned: the git dir never holds
 * a placed file's earlier content.
 */
export async function acceptIntoSnapshot(
  sandbox: Sandbox,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  const quoted = shellQuote(path)
  const next = `GIT_INDEX_FILE="$GIT_DIR/next-index"`
  const r = await sandbox.execOwn(
    `${snapshotEnv(sandbox)} && export GIT_LITERAL_PATHSPECS=1 && ${GIT} add -f -- ${quoted} && ` +
      `${next} ${GIT} read-tree HEAD && ${next} ${GIT} add -f -- ${quoted} && ` +
      `tree=$(${next} ${GIT} write-tree) && rm -f "$GIT_DIR/next-index" && ${RESET_HEAD}`,
    { signal },
  )
  if (r.exitCode !== 0) {
    throw new InfraError(`Failed to keep ${path} out of the diff: ${r.stderr.trim()}`)
  }
}

export async function diffSinceSnapshot(sandbox: Sandbox, signal?: AbortSignal): Promise<Diff> {
  const env = `${snapshotEnv(sandbox)} && ${GIT} add -A && `
  const patch = await sandbox.execOwn(`${env}${GIT} diff --cached --binary HEAD`, { signal })
  const names = await sandbox.execOwn(
    `${env}${GIT} diff --cached --name-status --no-renames HEAD`,
    { signal },
  )
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
  const r = await sandbox.execOwn(
    `${snapshotEnv(sandbox)} && ${GIT} add -A && ${GIT} ls-files -z`,
    {
      signal,
    },
  )
  if (r.exitCode !== 0)
    throw new InfraError(`Failed to list the workspace's files: ${r.stderr.trim()}`)
  return r.stdout.split('\0').filter(Boolean).sort()
}
