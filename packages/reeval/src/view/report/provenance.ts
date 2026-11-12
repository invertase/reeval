import type { RunRecord } from '../../history/types.ts'
import { harnessLabel, languageLabel, runtimeLabel } from '../model.ts'
import { runResourcesLine } from '../resources.ts'
import { recordHref, worktreePatchLink } from './links.ts'
import type { ProvenanceState } from './types.ts'

const short = (hash: string) => hash.replace(/^sha256:/, '').slice(0, 12)

/**
 * The state a run executed in, as label/value pairs. Pure and browser-safe.
 * The `Context` row is split out into `ProvenanceState.context` so Markdown can
 * put long file lists under `<details>`.
 */
export function stateRows(run: RunRecord): Array<{ field: string; value: string }> {
  const { git, stack: env } = run
  const rows: Array<{ field: string; value: string }> = []
  rows.push({
    field: 'Executed at',
    value: git
      ? `${git.sha.slice(0, 12)}${git.branch ? ` on ${git.branch}` : ''}${git.dirty ? ', dirty' : ', clean'} (the commit that adds this record is later)`
      : 'not a git repository',
  })
  if (git?.dirty) {
    const patch = worktreePatchLink(git.worktreePatch, git.worktreePatchNote)
    rows.push({
      field: 'Uncommitted',
      value: git.worktreePatch
        ? `worktree.patch, ${git.worktreePatch.bytes} bytes, sha256 ${short(git.worktreePatch.sha256)}`
        : `${patch.text}${git.diffHash ? `; sha256 ${short(git.diffHash)}` : ''}`,
    })
  }
  rows.push({
    field: 'Lockfiles',
    value:
      run.dependencies.lockfiles.map((l) => `${l.path} ${short(l.sha256)}`).join(', ') ||
      'none found',
  })
  rows.push({
    field: 'Images',
    value: env.images.length
      ? env.images
          .map(
            (i) =>
              `${i.ref} · id ${short(i.id)} · ${i.repoDigests[0] ?? 'no registry digest (built locally)'} · CLI ${i.agentCli ?? 'n/a'}${i.dockerfile ? ` · dockerfile ${i.dockerfile.path} ${short(i.dockerfile.sha256)}` : ''}${i.install?.length ? ` · install ${i.install.length} on ${i.base}` : ''}`,
          )
          .join('; ')
      : 'none (fake sandbox)',
  })
  rows.push({ field: 'Harnesses', value: env.harnesses.map(harnessLabel).join(', ') || 'none' })
  const resources = runResourcesLine(run.evals.flatMap((e) => e.attempts.map((a) => a.resources)))
  if (resources) rows.push({ field: 'Resources', value: resources })
  rows.push({
    field: 'Environments',
    value:
      run.environments
        .map(
          (e) =>
            `${e.name} ${short(e.digest)}${e.skills.length ? ` · skills ${e.skills.map((s) => `${s.name}${s.commit ? `@${s.commit.slice(0, 7)}` : ''}`).join(', ')}` : ''}${e.mcp.length ? ` · mcp ${e.mcp.join(', ')}` : ''}${e.secrets.length ? ` · secrets ${e.secrets.join(', ')}` : ''}`,
        )
        .join('; ') || 'none',
  })
  rows.push({
    field: 'Judge',
    value: `${env.judge.model ?? 'none by default'}${env.judge.resolvedModels.length ? ` (served ${env.judge.resolvedModels.join(', ')})` : ''} · threshold ${env.judge.threshold} · version ${env.judge.version}`,
  })
  rows.push({
    field: 'Packages',
    value: Object.entries(env.packages)
      .map(([name, v]) => `${name} ${v}`)
      .join(' · '),
  })
  const language = languageLabel(env)
  rows.push({
    field: 'reeval',
    value: `${env.reeval} · ${runtimeLabel(env)}${language ? ` · ${language}` : ''} · ${env.os}/${env.arch}`,
  })
  rows.push({
    field: 'Runner',
    value:
      run.runner.kind === 'ci'
        ? `CI (${run.runner.provider})${run.runner.runUrl ? ` ${run.runner.runUrl}` : ''}`
        : `local · ${run.author}`,
  })
  return rows
}

/**
 * One-line warnings for states that stop an exact rerun. Derived when shown,
 * never stored. Pure and browser-safe.
 */
export function warnings(run: RunRecord): string[] {
  const out: string[] = []
  for (const w of run.plan.sandboxWarnings) out.push(w.message)
  for (const image of run.stack.images.filter((i) => i.repoDigests.length === 0)) {
    out.push(
      `Image ${image.ref} isn't pushed, so an exact rerun needs this machine's image (id ${image.id.replace(/^sha256:/, '').slice(0, 12)}).`,
    )
  }
  if (!run.git) out.push("Not a git repository, so the code under test isn't pinned.")
  else if (run.git.dirty && !run.git.worktreePatch) {
    out.push(
      `Uncommitted changes weren't saved (${run.git.worktreePatchNote ?? 'no patch'}), so this exact state can't be recreated.`,
    )
  }
  return out
}

/** Provenance block for a run report. */
export function provenanceState(run: RunRecord, linkBase?: string): ProvenanceState {
  const contextFiles = run.stack.context.map((c) => ({
    path: c.path,
    sha256: c.sha256,
  }))
  return {
    rows: stateRows(run),
    context: { count: contextFiles.length, files: contextFiles },
    artifacts: run.artifacts,
    record: recordHref(run.runId, linkBase),
    warnings: warnings(run),
  }
}
