// The run-history commands: record, history, show, compare.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { git, gitText } from './git.ts'
import { listRuns, readRecord, recordRun, scratchDir } from './history/files.ts'
import { renderSummary } from './history/summary.ts'
import type { ArtifactLevel, HistoryEntry } from './history/types.ts'
import {
  compare,
  formatCompare,
  formatHistory,
  formatShow,
  history,
  pickBaseline,
  type Reachability,
  resolveRun,
  stackChanges,
} from './history/views.ts'
import { sha256 } from './ids.ts'
import type { ResolvedConfig } from './types.ts'

export type HistoryFlags = {
  json?: boolean
  md?: boolean
  all?: boolean
  artifacts?: string
  'allow-incomplete'?: boolean
  'skip-secret-scan'?: boolean
  limit?: string
  'fail-on-regression'?: boolean
}

export class CommandError extends Error {
  override name = 'CommandError'
}

type Ctx = { config: ResolvedConfig; flags: HistoryFlags; out: (s: string) => void }

const recorded = (config: ResolvedConfig) => listRuns(config.root, config.history.dir, true)
const scratch = (config: ResolvedConfig) => listRuns(config.root, scratchDir(config.root), false)

/** Recorded runs plus scratch runs that weren't recorded, sorted by run id. */
export async function allRuns(config: ResolvedConfig): Promise<HistoryEntry[]> {
  const kept = await recorded(config)
  const ids = new Set(kept.map((e) => e.runId))
  return [...kept, ...(await scratch(config)).filter((e) => !ids.has(e.runId))].sort((a, b) =>
    a.runId < b.runId ? -1 : 1,
  )
}

export async function lines(root: string, args: string[]): Promise<string[] | null> {
  const r = await git(root, args)
  if (r.code !== 0) return null
  return r.stdout.toString('utf8').split('\n').filter(Boolean)
}

/** Commits reachable from HEAD; null when git can't tell (no repo, or a shallow clone). */
export async function reachability(root: string): Promise<Reachability> {
  const shallow = await lines(root, ['rev-parse', '--is-shallow-repository'])
  if (!shallow || shallow[0] === 'true') return null
  const shas = await lines(root, ['rev-list', '--max-count=20000', 'HEAD'])
  return shas ? new Set(shas) : null
}

const rel = (path: string) => relative(process.cwd(), path) || path

export function parseLevel(value: string | undefined, fallback: ArtifactLevel): ArtifactLevel {
  if (value === undefined) return fallback
  if (value === 'all' || value === 'failures' || value === 'none') return value
  throw new CommandError('--artifacts must be all, failures or none')
}

export async function record(
  config: ResolvedConfig,
  runId: string,
  flags: HistoryFlags,
): Promise<string> {
  const result = await recordRun({
    root: config.root,
    historyDir: config.history.dir,
    runId,
    artifacts: parseLevel(flags.artifacts, config.history.artifacts),
    allowIncomplete: flags['allow-incomplete'],
    skipSecretScan: flags['skip-secret-scan'],
  })
  const where = rel(result.recordPath)
  if (!result.created) return `${where} is already recorded`
  const kb = (result.bytes / 1024).toFixed(1)
  const extra = result.artifactDir
    ? ` + ${result.files} artifact files in ${rel(result.artifactDir)}/`
    : ''
  return `recorded ${where}${extra} (${kb} KB). Commit it with git.`
}

export async function recordCommand(ctx: Ctx, refs: string[]): Promise<number> {
  const runs = await scratch(ctx.config)
  for (const ref of refs.length ? refs : ['latest']) {
    ctx.out(await record(ctx.config, resolveRun(runs, ref).runId, ctx.flags))
  }
  return 0
}

export async function historyCommand(ctx: Ctx, filter: string[]): Promise<number> {
  const entries = ctx.flags.all ? await allRuns(ctx.config) : await recorded(ctx.config)
  const limit = ctx.flags.limit ? Number(ctx.flags.limit) : 20
  if (!(limit > 0)) throw new CommandError('--limit must be a positive number')
  const reach = await reachability(ctx.config.root)
  const view = history(entries, { filter: filter.join(' ') || undefined, limit, reach })
  ctx.out(ctx.flags.json ? JSON.stringify(view, null, 2) : formatHistory(view))
  return 0
}

export async function showCommand(ctx: Ctx, refs: string[]): Promise<number> {
  const entry = resolveRun(await allRuns(ctx.config), refs[0])
  const dir = entry.recorded ? ctx.config.history.dir : scratchDir(ctx.config.root)
  const run = await readRecord(join(dir, `${entry.runId}.json`))
  if (ctx.flags.json) ctx.out(JSON.stringify(run, null, 2))
  else if (ctx.flags.md) ctx.out(renderSummary(run).trimEnd())
  else ctx.out(formatShow(run))
  return 0
}

export async function compareCommand(ctx: Ctx, refs: string[]): Promise<number> {
  const { root } = ctx.config
  const entries = await allRuns(ctx.config)
  const reach = await reachability(root)
  let base: HistoryEntry | null
  let head: HistoryEntry
  if (refs.length >= 2) {
    base = resolveRun(entries, refs[0])
    head = resolveRun(entries, refs[1])
  } else {
    head = resolveRun(entries, refs[0] ?? 'latest')
    // Ancestry of head's commit, or of HEAD when that commit was rebased away.
    const from = head.git && (!reach || reach.has(head.git.sha)) ? head.git.sha : 'HEAD'
    const ancestry = await lines(root, ['rev-list', '--max-count=5000', from])
    const candidates = entries.filter((e) => e.recorded && e.runId !== head.runId)
    base = pickBaseline(candidates, head, ancestry)
    if (!base) throw new CommandError(`No earlier recorded run to compare ${head.runId} with`)
  }
  const rows = compare(base, head)
  if (ctx.flags.json) {
    const flag = (e: HistoryEntry) => ({
      runId: e.runId,
      recorded: e.recorded,
      inHistory: !reach || !e.git ? null : reach.has(e.git.sha),
    })
    ctx.out(
      JSON.stringify(
        { base: flag(base), head: flag(head), changes: stackChanges(base, head), rows },
        null,
        2,
      ),
    )
  } else ctx.out(formatCompare(base, head, rows, !!ctx.flags.md, reach))
  return ctx.flags['fail-on-regression'] && rows.some((r) => r.status === 'regressed') ? 1 : 0
}

/** Recreates the state a run executed in: its commit, plus its uncommitted changes if any. */
export async function checkoutCommand(ctx: Ctx, args: string[]): Promise<number> {
  const { root } = ctx.config
  const entry = resolveRun(await allRuns(ctx.config), args[0] ?? 'latest')
  const dir = entry.recorded ? ctx.config.history.dir : scratchDir(root)
  const run = await readRecord(join(dir, `${entry.runId}.json`))
  if (!run.git) throw new CommandError(`${run.runId} didn't run in a git repository`)
  const { sha } = run.git
  if ((await git(root, ['cat-file', '-e', `${sha}^{commit}`])).code !== 0) {
    throw new CommandError(
      `Commit ${sha.slice(0, 12)} isn't in this clone (rebased or not fetched). Fetch it, then try again.`,
    )
  }
  const target = resolve(args[1] ?? join(root, '.es', 'checkouts', run.runId))
  if (existsSync(target)) throw new CommandError(`${rel(target)} already exists`)
  await gitText(root, ['worktree', 'add', '--detach', '-q', target, sha])
  const patchRef = run.git.worktreePatch
  let applied = ''
  if (patchRef) {
    const patchPath = join(dir, run.runId, patchRef.path)
    const bytes = await readFile(patchPath)
    if (sha256(bytes) !== patchRef.sha256) {
      throw new CommandError(`${rel(patchPath)} doesn't match the hash in the record`)
    }
    const r = await git(target, ['apply', '--binary', '--whitespace=nowarn', patchPath])
    if (r.code !== 0) throw new CommandError(`Applying worktree.patch failed: ${r.stderr.trim()}`)
    applied = ' and applied worktree.patch'
  } else if (run.git.dirty) {
    applied = ` (the run was dirty, but its changes weren't saved: ${run.git.worktreePatchNote ?? 'unknown'})`
  }
  ctx.out(
    `checked out ${sha.slice(0, 12)} into ${rel(target)}${applied}.\nRemove it with: git worktree remove ${rel(target)}`,
  )
  return 0
}
