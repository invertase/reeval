// The run-history commands: record, history, show, compare, checkout.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { hasAnalysisModel } from './config.ts'
import { git, gitText } from './git.ts'
import { listRuns, readRecord, recordRun, scratchDir } from './history/files.ts'
import { renderSummary } from './history/summary.ts'
import type { ArtifactLevel, HistoryEntry } from './history/types.ts'
import {
  type CompareRow,
  compare,
  formatHistory,
  formatShow,
  history,
  newRows,
  pickBaseline,
  type Reachability,
  resolveRun,
  stackChanges,
  unreachable,
} from './history/views.ts'
import { fromCwd, sha256 } from './ids.ts'
import { readInsights, runInsightsFile } from './insights/files.ts'
import type { ResolvedConfig } from './types.ts'
import { renderCompare, renderCompareMarkdown } from './ui/compare-layout.ts'
import { fromModel } from './view/insights.ts'
import { suiteResult } from './view/suite.ts'

export type HistoryFlags = {
  json?: boolean
  md?: boolean
  all?: boolean
  artifacts?: string
  'allow-incomplete'?: boolean
  'skip-secret-scan'?: boolean
  limit?: string
  'fail-on-regression'?: boolean
  verbose?: boolean[]
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

const rel = (path: string) => fromCwd(path) || path

export function parseLevel(value: string | undefined, fallback: ArtifactLevel): ArtifactLevel {
  if (value === undefined) return fallback
  if (value === 'all' || value === 'failures' || value === 'none') return value
  throw new CommandError(`--artifacts is all, failures or none (got ${value})`)
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
    hint: !hasAnalysisModel(config),
  })
  const where = rel(result.recordPath)
  if (!result.created) return `${where} is already recorded`
  const kb = (result.bytes / 1024).toFixed(1)
  const extra = result.artifactDir
    ? ` + ${result.files} artifact files in ${rel(result.artifactDir)}/`
    : ''
  const recorded = `recorded ${where}${extra} (${kb} KB). Commit it with git.`
  const ignored =
    result.ignored.length === 0
      ? []
      : [
          `warning: git ignores ${result.ignored.length} recorded file(s); they won't be committed:`,
          ...result.ignored.map((i) => `  ${i.path}  ignored by ${i.rule} (${i.source})`),
        ]
  if (result.droppedPatch.length === 0) {
    return ignored.length === 0 ? recorded : `${ignored.join('\n')}\n${recorded}`
  }
  const artifacts = result.artifactDir ? `${rel(result.artifactDir)}/` : ''
  return [
    `warning: left worktree.patch out of ${runId}: it looks like it holds a secret.`,
    ...result.droppedPatch.map((line) => `  ${line}`),
    "  worktree.patch is your checkout's uncommitted changes when the run started (git status), not the agents' work.",
    "  Nothing was committed. Take the key out of those files, or add them to .gitignore, so a later commit doesn't carry it; rotate the key only if it's already been committed or pushed. The record says the patch was left out, so reeval checkout recreates the commit alone.",
    `  To keep it after checking by hand: delete ${where} and ${artifacts || 'its artifacts'}, then reeval record ${runId} --skip-secret-scan.`,
    ...ignored,
    recorded,
  ].join('\n')
}

export async function recordCommand(ctx: Ctx, refs: string[]): Promise<number> {
  const runs = await scratch(ctx.config)
  for (const ref of refs.length ? refs : ['latest']) {
    ctx.out(await record(ctx.config, resolveRun(runs, ref).runId, ctx.flags))
  }
  return 0
}

/** `reeval history --json`: recent runs (recorded, or with `all` scratch ones too) and each eval's strip. */
export async function historyView(
  config: ResolvedConfig,
  options: { filter?: string; limit?: number; all?: boolean } = {},
) {
  const entries = options.all ? await allRuns(config) : await recorded(config)
  const limit = options.limit ?? 20
  if (!(limit > 0))
    throw new CommandError(`--limit must be a number above 0 (got ${options.limit})`)
  const reach = await reachability(config.root)
  return history(entries, { filter: options.filter || undefined, limit, reach })
}

export async function historyCommand(ctx: Ctx, filter: string[]): Promise<number> {
  const view = await historyView(ctx.config, {
    filter: filter.join(' '),
    limit: ctx.flags.limit ? Number(ctx.flags.limit) : undefined,
    all: ctx.flags.all,
  })
  ctx.out(ctx.flags.json ? JSON.stringify(view, null, 2) : formatHistory(view))
  return 0
}

/** A listed run's record, from the history folder or the scratch runs. */
const recordOf = (config: ResolvedConfig, entry: HistoryEntry) =>
  readRecord(
    join(entry.recorded ? config.history.dir : scratchDir(config.root), `${entry.runId}.json`),
  )

/** The record of the run `ref` names (default latest), recorded or scratch. */
export async function showRecord(config: ResolvedConfig, ref?: string) {
  return recordOf(config, resolveRun(await allRuns(config), ref))
}

export async function showCommand(ctx: Ctx, refs: string[]): Promise<number> {
  const { config } = ctx
  const entry = resolveRun(await allRuns(config), refs[0])
  const dir = entry.recorded ? config.history.dir : scratchDir(config.root)
  const run = await readRecord(join(dir, `${entry.runId}.json`))
  if (ctx.flags.json) {
    ctx.out(JSON.stringify(run, null, 2))
    return 0
  }
  const insights = await readInsights(runInsightsFile(config, entry))
  const hint = !(insights && fromModel(insights)) && !hasAnalysisModel(config)
  if (ctx.flags.md) ctx.out(renderSummary(run, { hint, insights }).trimEnd())
  else ctx.out(formatShow(run, { hint, insights }))
  return 0
}

/**
 * Two runs and their rows: `base` and `head` when both are given, else `head` (default latest)
 * against its nearest recorded ancestor. `json` is what `reeval compare --json` prints.
 */
export async function compareView(config: ResolvedConfig, refs: string[]) {
  const { root } = config
  const entries = await allRuns(config)
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
  }
  const rows = base ? compare(base, head) : newRows(head)
  const flag = (e: HistoryEntry) => ({
    runId: e.runId,
    recorded: e.recorded,
    inHistory: !reach || !e.git ? null : reach.has(e.git.sha),
  })
  const json = base
    ? { base: flag(base), head: flag(head), changes: stackChanges(base, head), rows }
    : { base: null, head: { runId: head.runId }, changes: [], rows }
  return { base, head, rows, reach, json }
}

export async function compareCommand(ctx: Ctx, refs: string[]): Promise<number> {
  const { base, head, rows, reach, json } = await compareView(ctx.config, refs)
  const failing = regressions(rows)
  if (ctx.flags.json) ctx.out(JSON.stringify(json, null, 2))
  else {
    const side = async (e: HistoryEntry) => {
      const record = await recordOf(ctx.config, e)
      return {
        runId: e.runId,
        suite: suiteResult(record),
        unreachable: unreachable(e, reach),
        status: record.status,
      }
    }
    const input = {
      base: base ? await side(base) : null,
      head: await side(head),
      rows,
      changes: base ? stackChanges(base, head) : [],
    }
    const opts = { color: false, verbose: !!ctx.flags.verbose?.length }
    ctx.out(
      ctx.flags.md
        ? renderCompareMarkdown(input, opts).trimEnd()
        : renderCompare(input, opts).join('\n'),
    )
  }
  return ctx.flags['fail-on-regression'] && failing.length ? 1 : 0
}

/**
 * What `--fail-on-regression` fails on: an eval or a pooled family's gate that went from pass to
 * fail, and a new or changed (can't compare) one that fails, since nothing earlier vouches for it.
 * A head the run's interrupt cancelled didn't fail.
 */
export const regressions = (rows: CompareRow[]) =>
  rows.filter(
    (r) =>
      r.status === 'regressed' ||
      ((r.status === 'added' || r.status === 'drift') &&
        r.head === 'fail' &&
        !r.cancelled?.includes('head')),
  )

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
  const target = resolve(args[1] ?? join(root, '.reeval', 'checkouts', run.runId))
  if (existsSync(target)) throw new CommandError(`${rel(target)} already exists`)
  const patchRef = run.git.worktreePatch
  const patchPath = patchRef && join(dir, run.runId, patchRef.path)
  if (patchRef && patchPath) {
    const bytes = await readFile(patchPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (!bytes) {
      throw new CommandError(
        `${rel(patchPath)} is missing, but the record says the run's uncommitted changes are in it. ${entry.recorded ? "Restore it from git, where it's committed with the record, then try again." : "It's gone from .reeval/runs, so those changes can't be recreated."}`,
      )
    }
    if (sha256(bytes) !== patchRef.sha256) {
      throw new CommandError(`${rel(patchPath)} doesn't match the hash in the record`)
    }
  }
  await gitText(root, ['worktree', 'add', '--detach', '-q', target, sha])
  let applied = ''
  if (patchPath) {
    const r = await git(target, ['apply', '--binary', '--whitespace=nowarn', patchPath])
    if (r.code !== 0) throw new CommandError(`Applying worktree.patch failed: ${r.stderr.trim()}`)
    applied = ' and applied worktree.patch'
  } else if (run.git.dirty) {
    applied = `, without the run's uncommitted changes: they weren't saved (${run.git.worktreePatchNote ?? 'unknown'})`
  }
  ctx.out(
    `checked out ${sha.slice(0, 12)} into ${rel(target)}${applied}.\nRemove it with: git worktree remove ${rel(target)}`,
  )
  return 0
}
