import type { Sandbox } from './sandbox/types.ts'
import { InfraError } from './sandbox/types.ts'
import type { Diff, FileChange } from './types.ts'

const GIT = 'git -c user.name=es -c user.email=es@localhost -c core.hooksPath=/dev/null'

/** Records the workspace state before the agent runs, in a git dir outside the workspace. */
export async function snapshot(sandbox: Sandbox, signal?: AbortSignal): Promise<void> {
  const r = await sandbox.exec(
    `export GIT_DIR="$PWD/../.reeval-git-$(basename "$PWD")" GIT_WORK_TREE="$PWD" && ` +
      `${GIT} init -q && ${GIT} add -A && ${GIT} commit -q --allow-empty -m base`,
    { signal },
  )
  if (r.exitCode !== 0) throw new InfraError(`Failed to snapshot the workspace: ${r.stderr.trim()}`)
}

export async function diffSinceSnapshot(sandbox: Sandbox, signal?: AbortSignal): Promise<Diff> {
  const env = `export GIT_DIR="$PWD/../.reeval-git-$(basename "$PWD")" GIT_WORK_TREE="$PWD" && ${GIT} add -A && `
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
