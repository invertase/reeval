import { shellQuote } from '@reeval/sandbox-docker/process'
import type { Sandbox } from './sandbox/types.ts'
import { InfraError } from './sandbox/types.ts'
import type { Diff, FileChange } from './types.ts'

// No reflog and no automatic gc: `prune` then removes every object HEAD and the index don't
// reach, and nothing is ever packed where a loose-object prune can't remove it.
// `core.quotePath=false` keeps non-ASCII paths readable in the patch; git still C-quotes a path
// with a tab, newline, `"` or `\` there. Only `-z` output is never quoted.
const GIT =
  'git -c user.name=reeval -c user.email=reeval@localhost -c core.hooksPath=/dev/null' +
  ' -c core.logAllRefUpdates=false -c gc.auto=0 -c core.quotePath=false'

// The git dir is root's, but `execOwn`'s HOME is the image's, which a custom `from` image could
// point at the agent's own home. Ignore every config file git would otherwise read, so the agent
// can't make reeval's privileged git run its code through a planted `~/.gitconfig` (an fsmonitor,
// a `filter.*.clean`, a diff `textconv`) or weaken it with `safe.directory`. Hooks are off too.
const snapshotEnv = (sandbox: Sandbox) =>
  `export GIT_DIR=${shellQuote(`${sandbox.stateDir}/workspace.git`)}` +
  ` GIT_WORK_TREE=${shellQuote(sandbox.workdir)}` +
  ' GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null'

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

/**
 * Each file that differs from the snapshot, by path, and the object id of its content now (all
 * zeros once deleted). A path not in it is as the snapshot has it.
 */
export type Blobs = ReadonlyMap<string, string>

type RawChange = FileChange & { blob: string }

async function rawChanges(sandbox: Sandbox, signal?: AbortSignal): Promise<RawChange[]> {
  const r = await sandbox.execOwn(
    `${snapshotEnv(sandbox)} && ${GIT} add -A && ${GIT} diff --cached --raw --no-renames --no-abbrev -z HEAD`,
    { signal },
  )
  if (r.exitCode !== 0) throw new InfraError(`Failed to diff the workspace: ${r.stderr}`)
  const status = { A: 'added', M: 'modified', D: 'deleted' } as const
  // `-z` gives `:<mode> <mode> <old id> <new id> <status>\0<path>\0` pairs, the path as is.
  const fields = r.stdout.split('\0')
  const changes: RawChange[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, , , blob = '', code = ''] = (fields[i] as string).split(' ')
    changes.push({
      path: fields[i + 1] as string,
      status: status[code[0] as keyof typeof status] ?? 'modified',
      blob,
    })
  }
  return changes
}

const blobsOf = (changes: RawChange[]): Blobs => new Map(changes.map((c) => [c.path, c.blob]))

export async function diffSinceSnapshot(
  sandbox: Sandbox,
  signal?: AbortSignal,
): Promise<{ diff: Diff; blobs: Blobs }> {
  const patch = await sandbox.execOwn(
    `${snapshotEnv(sandbox)} && ${GIT} add -A && ${GIT} diff --cached --binary HEAD`,
    { signal },
  )
  if (patch.exitCode !== 0) throw new InfraError(`Failed to diff the workspace: ${patch.stderr}`)
  const changes = await rawChanges(sandbox, signal)
  const files = changes.map(({ path, status }) => ({ path, status }))
  return { diff: { patch: patch.stdout, files }, blobs: blobsOf(changes) }
}

/** The workspace's `Blobs` now, to tell later which files a turn changed. */
export async function workspaceBlobs(sandbox: Sandbox, signal?: AbortSignal): Promise<Blobs> {
  return blobsOf(await rawChanges(sandbox, signal))
}

/** Paths whose content differs between two `Blobs`: a file changed, created or deleted between them. */
export function changedBetween(before: Blobs, after: Blobs): string[] {
  const paths = new Set([...after.keys(), ...before.keys()])
  return [...paths].filter((p) => before.get(p) !== after.get(p))
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
