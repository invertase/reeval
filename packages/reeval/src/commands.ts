// The run-history commands: record, history, show, compare, checkout.

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { debugRoot } from './debug/files.ts'
import { git, gitText } from './git.ts'
import {
  listRuns,
  type RecordResult,
  readRecord,
  recordRun,
  runDir,
  scratchDir,
} from './history/files.ts'
import { readReportInputs } from './history/report-inputs.ts'
import { renderSummary } from './history/summary.ts'
import type { ArtifactLevel, HistoryEntry, RunDebug } from './history/types.ts'
import {
  type CompareRow,
  compare,
  formatHistory,
  formatShow,
  history,
  newRows,
  pickBaseline,
  type Reachability,
  RefError,
  resolveRun,
  stackChanges,
  unreachable,
} from './history/views.ts'
import { fromCwd, sha256 } from './ids.ts'
import { readRemarks, runRemarksFile } from './remarks/files.ts'
import {
  checkStore,
  debugStaging,
  isRemote,
  markPending,
  notUploaded,
  pendingDir,
  pendingRuns,
  pullDebug,
  pullStore,
  type RemoteHistory,
  StoreError,
  type Uploaded,
  unmarkPending,
  uploadPending,
} from './store/sync.ts'
import type { ResolvedConfig } from './types.ts'
import { renderCompare } from './ui/compare-layout.ts'
import { runCost } from './view/cost.ts'
import type { LiveRun } from './view/live.ts'
import type { TranscriptLine } from './view/model.ts'
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
  trace?: boolean
  out?: string
  debug?: boolean
  'push-only'?: boolean
}

export class CommandError extends Error {
  override name = 'CommandError'
}

type Ctx = { config: ResolvedConfig; flags: HistoryFlags; out: (s: string) => void }

/** Recorded runs; from a remote store, those HEAD reaches unless `--all-branches` (`scoped`). */
async function recorded(config: ResolvedConfig, scoped = true): Promise<HistoryEntry[]> {
  const runs = await listRuns(config.root, config.history.dir, true)
  if (!scoped || config.history.scope !== 'reachable') return runs
  const reach = await reachability(
    config.root,
    runs.map((e) => e.git?.sha),
  )
  return runs.filter((e) => !unreachable(e, reach))
}
const scratch = (config: ResolvedConfig) => listRuns(config.root, scratchDir(config.root), false)

/** Recorded runs plus scratch runs that weren't recorded, sorted by run id. */
export async function allRuns(config: ResolvedConfig, scoped = true): Promise<HistoryEntry[]> {
  const kept = await recorded(config, scoped)
  const ids = new Set(kept.map((e) => e.runId))
  return [...kept, ...(await scratch(config)).filter((e) => !ids.has(e.runId))].sort((a, b) =>
    a.runId < b.runId ? -1 : 1,
  )
}

/** The run `ref` names, recorded or not; a run id or SHA also finds a remote store's runs on other branches. */
export async function pick(config: ResolvedConfig, ref = 'latest', entries?: HistoryEntry[]) {
  const scoped = entries ?? (await allRuns(config))
  try {
    return resolveRun(scoped, ref)
  } catch (error) {
    if (!(error instanceof RefError) || config.history.scope !== 'reachable') throw error
    if (/^latest(?:~\d+)?$/.test(ref)) throw error
    return resolveRun(await allRuns(config, false), ref)
  }
}

/** The run `ref` names, as `show` resolves it; one only in `.reeval/runs` is refused with how to record it. */
export async function recordedRun(config: ResolvedConfig, ref = 'latest'): Promise<HistoryEntry> {
  const found = await pick(config, ref)
  if (found.recorded) return found
  throw new CommandError(
    `Run ${found.runId} isn't recorded: reeval record ${found.runId} records it into the history folder first`,
  )
}

export async function lines(root: string, args: string[]): Promise<string[] | null> {
  const r = await git(root, args)
  if (r.code !== 0) return null
  return r.stdout.toString('utf8').split('\n').filter(Boolean)
}

const LISTED = 20_000
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/**
 * Commits reachable from HEAD that `shas` asks about; null when git can't tell (no repo, or a
 * shallow clone). It lists HEAD's newest commits, and when the history goes further back, asks git
 * about each of `shas` that list leaves out.
 */
export async function reachability(
  root: string,
  shas: Array<string | undefined>,
): Promise<Reachability> {
  const shallow = await lines(root, ['rev-parse', '--is-shallow-repository'])
  if (!shallow || shallow[0] === 'true') return null
  const listed = await lines(root, ['rev-list', `--max-count=${LISTED}`, 'HEAD'])
  if (!listed) return null
  const reach = new Set(listed)
  await settle(root, reach, shas)
  return reach
}

/**
 * Adds each of `shas` that's an ancestor of HEAD but past the commits `reach` lists. One commit is
 * one `merge-base`; several are one walk of HEAD's whole history, since each `merge-base` costs
 * about a walk.
 */
async function settle(root: string, reach: Reachability, shas: Array<string | undefined>) {
  if (!reach || reach.size < LISTED) return
  const asked = new Set(
    shas.filter((sha): sha is string => !!sha && FULL_SHA.test(sha) && !reach.has(sha)),
  )
  const [only, ...more] = asked
  if (only && more.length === 0) {
    if ((await git(root, ['merge-base', '--is-ancestor', only, 'HEAD'])).code === 0) reach.add(only)
  } else if (only) {
    for (const sha of (await lines(root, ['rev-list', `--skip=${LISTED}`, 'HEAD'])) ?? []) {
      if (asked.has(sha)) reach.add(sha)
    }
  }
}

const rel = (path: string) => fromCwd(path) || path

export function parseLevel(value: string | undefined, fallback: ArtifactLevel): ArtifactLevel {
  if (value === undefined) return fallback
  if (value === 'all' || value === 'evidence' || value === 'failures' || value === 'none') {
    return value
  }
  throw new CommandError(`--artifacts is all, evidence, failures or none (got ${value})`)
}

export async function record(
  config: ResolvedConfig,
  runId: string,
  flags: HistoryFlags,
  /** Told where the run landed, and awaited, before a remote store's upload, which can still fail. */
  onRecorded?: (result: RecordResult) => void | Promise<void>,
): Promise<string> {
  const remote = isRemote(config.history) ? config.history : null
  const marked = remote ? await markPending(remote, runId) : true
  let result: RecordResult
  try {
    result = await recordRun({
      root: config.root,
      historyDir: config.history.dir,
      runId,
      artifacts: parseLevel(flags.artifacts, config.history.artifacts),
      allowIncomplete: flags['allow-incomplete'],
      skipSecretScan: flags['skip-secret-scan'],
      committed: !remote,
      archive: config.history.archive,
      debugArchive: config.history.debugArchive,
      ...(remote && remote.debug !== 'none'
        ? { debug: { level: remote.debug, staging: debugStaging(remote, runId) } }
        : {}),
    })
  } catch (error) {
    if (remote && !marked) await unmarkPending(remote, runId)
    throw error
  }
  await onRecorded?.(result)
  if (remote) return recordRemote(remote, runId, result)
  const where = rel(result.recordPath)
  const ignored =
    result.ignored.length === 0
      ? []
      : [
          `warning: git ignores ${result.ignored.length} recorded file(s); they won't be committed:`,
          ...result.ignored.map((i) => `  ${i.path}  ignored by ${i.rule} (${i.source})`),
        ]
  const archived = result.archive?.written ? `; archived it in ${rel(result.archive.path)}` : ''
  const debugZip = result.debugArchive?.written
    ? `\nZipped its debug data in ${rel(result.debugArchive.path)}, which stays out of git.`
    : ''
  if (!result.created) {
    return [...ignored, `${where} is already recorded${archived}${debugZip}`].join('\n')
  }
  const kb = (result.bytes / 1024).toFixed(1)
  const extra = result.artifactDir
    ? ` + ${result.files} artifact files in ${rel(result.artifactDir)}/`
    : ''
  const recorded = `recorded ${where}${extra} (${kb} KB)${archived}. Commit it with git.${debugZip}`
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

/** The copy's run uploaded to its store; a StoreError, naming `reeval sync`, if it didn't. */
const debugNote = (debug: RunDebug | undefined) => {
  if (!debug?.files.length) return ''
  const kb = (debug.files.reduce((n, f) => n + f.bytes, 0) / 1024).toFixed(1)
  const n = debug.files.length
  return `, ${n} debug file${n === 1 ? '' : 's'}, ${kb} KB`
}

async function recordRemote(
  history: RemoteHistory,
  runId: string,
  result: RecordResult,
): Promise<string> {
  const name = history.store.name
  let uploaded: Uploaded
  try {
    uploaded = await uploadPending(history, runId)
  } catch (error) {
    if (!(error instanceof StoreError)) throw error
    await markPending(history, runId)
    throw new StoreError(notUploaded(error, rel(pendingDir(history))))
  }
  const kb = (result.bytes / 1024).toFixed(1)
  const line =
    uploaded === 'already'
      ? `${runId} is already recorded in ${name}`
      : `${uploaded === 'replaced' ? 'updated' : 'recorded'} ${runId} in ${name} (${result.files + 1} files, ${kb} KB${debugNote(result.debug)})`
  const dropped = (result.debug?.dropped ?? []).map(
    (d) =>
      `warning: left debug/${d.path} out of ${runId}'s upload: ${d.note.replace(/^not kept: /, '')}`,
  )
  if (result.droppedPatch.length === 0) return [...dropped, line].join('\n')
  return [
    ...dropped,
    `warning: left worktree.patch out of ${runId}: it looks like it holds a secret.`,
    ...result.droppedPatch.map((l) => `  ${l}`),
    "  worktree.patch is your checkout's uncommitted changes when the run started (git status), not the agents' work. The record says the patch was left out, so reeval checkout recreates the commit alone.",
    line,
  ].join('\n')
}

/**
 * `reeval sync`: uploads every run recorded into the store's copy that didn't upload, then pulls
 * the runs recorded elsewhere into it.
 */
export async function syncCommand(ctx: Ctx, refs: string[] = []): Promise<number> {
  const history = ctx.config.history
  if (refs.length && !ctx.flags.debug) {
    throw new CommandError(
      'reeval sync takes runs with --debug only: reeval sync --debug <run> downloads their debug data',
    )
  }
  if (ctx.flags.debug && ctx.flags['push-only']) {
    throw new CommandError(
      'reeval sync --debug downloads, and --push-only does not: drop one of them',
    )
  }
  if (!isRemote(history)) {
    ctx.out(
      ctx.flags.debug
        ? `history.store is local(): each run's debug data stays in ${rel(debugRoot(ctx.config.root))}, nothing to download`
        : `history.store is local(): runs are recorded in ${rel(history.dir)}, nothing to sync`,
    )
    return 0
  }
  const runs = await pendingRuns(history)
  const failed: string[] = []
  for (const runId of runs) {
    try {
      const done = await uploadPending(history, runId)
      ctx.out(
        `${done === 'already' ? 'already in' : 'uploaded to'} ${history.store.name}: ${runId}`,
      )
    } catch (error) {
      if (!(error instanceof StoreError)) throw error
      failed.push(error.message)
    }
  }
  if (failed.length) {
    throw new StoreError(notUploaded(new StoreError(failed.join('\n')), rel(pendingDir(history))))
  }
  if (ctx.flags['push-only']) {
    await checkStore(history)
    ctx.out(
      `${runs.length ? `uploaded ${runs.length}` : 'nothing to upload'} to ${history.store.name}, which answers; pulled nothing (--push-only)`,
    )
    return 0
  }
  const { pulled, unreachable } = await pullStore(history, { force: true })
  if (unreachable) throw new StoreError(`couldn't read ${history.store.name}: ${unreachable}`)
  ctx.out(
    `${runs.length ? `uploaded ${runs.length}` : 'nothing to upload'}, pulled ${pulled} run(s) from ${history.store.name}`,
  )
  if (ctx.flags.debug) {
    for (const ref of refs.length ? refs : ['latest']) {
      ctx.out(await downloadDebug(ctx.config, history, ref))
    }
  }
  return 0
}

/** `reeval sync --debug <run>`: one run's debug data from the store, into `.reeval/debug/<run>`. */
async function downloadDebug(config: ResolvedConfig, history: RemoteHistory, ref: string) {
  const entry = await pick(config, ref)
  const where = rel(join(debugRoot(config.root), entry.runId))
  if (!entry.recorded) {
    return `${entry.runId} isn't in ${history.store.name}: it ran here, so its debug data is in ${where} until reeval clean removes it`
  }
  const got = await pullDebug(history, config.root, entry.runId)
  if (!got.debug) {
    return `${entry.runId} was recorded without debug data: set history.debug to 'requests' or 'all' for the runs it records`
  }
  const dropped = got.debug.dropped?.length
    ? ` (${got.debug.dropped.length} left out when it was recorded: they looked like they held a secret)`
    : ''
  if (!got.downloaded) return `${entry.runId}'s debug data is already in ${where}${dropped}`
  const kb = (got.bytes / 1024).toFixed(1)
  return `downloaded ${got.downloaded} debug file${got.downloaded === 1 ? '' : 's'} of ${entry.runId} (${kb} KB) into ${where}${dropped}`
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
  const shown = entries.slice(-limit).map((e) => e.git?.sha)
  const reach = config.history.scope ? null : await reachability(config.root, shown)
  const view = history(entries, { filter: options.filter || undefined, limit, reach })
  return { ...view, stopped: await stoppedRuns(config) }
}

export async function historyCommand(ctx: Ctx, filter: string[]): Promise<number> {
  const view = await historyView(ctx.config, {
    filter: filter.join(' '),
    limit: ctx.flags.limit ? Number(ctx.flags.limit) : undefined,
    all: ctx.flags.all,
  })
  ctx.out(
    ctx.flags.json
      ? JSON.stringify(view, null, 2)
      : [formatHistory(view), ...formatStopped(view.stopped, ctx.config.root)].join('\n'),
  )
  return 0
}

/** A run whose `reeval run` exited or went quiet before it wrote its record. */
type StoppedRun = Pick<LiveRun, 'runId' | 'startedAt' | 'phase' | 'planned'> & {
  finished: number
}

async function stoppedRuns(config: ResolvedConfig): Promise<StoppedRun[]> {
  const { listLive } = await import('./studio/live.ts')
  const live = await listLive({ root: config.root, historyDir: config.history.dir, scratch: true })
  return live
    .filter((r) => r.state === 'stopped')
    .reverse()
    .map((r) => ({
      runId: r.runId,
      startedAt: r.startedAt,
      phase: r.phase,
      planned: r.planned,
      finished: r.counts.passed + r.counts.failed + r.counts.errored,
    }))
}

function formatStopped(stopped: StoppedRun[], root: string): string[] {
  if (!stopped.length) return []
  const how = {
    cancelling: 'canceled',
    finishing: 'stopped writing its record',
    running: 'stopped',
  }
  const last = stopped[stopped.length - 1] as StoppedRun
  return [
    '',
    `${stopped.length} run${stopped.length === 1 ? '' : 's'} stopped without writing a record:`,
    ...stopped.map(
      (r) => `  ${r.runId}  ${how[r.phase]}, ${r.finished} of ${r.planned} attempts finished`,
    ),
    `reeval run --resume ${last.runId} keeps the attempts that finished, runs the rest and writes the record; deleting ${fromCwd(join(root, '.reeval', 'staging', last.runId))} discards the run.`,
  ]
}

/** A listed run's record, from the history folder or the scratch runs. */
const recordOf = (config: ResolvedConfig, entry: HistoryEntry) =>
  readRecord(
    join(entry.recorded ? config.history.dir : scratchDir(config.root), `${entry.runId}.json`),
  )

/** The record of the run `ref` names (default latest), recorded or scratch. */
export async function showRecord(config: ResolvedConfig, ref?: string) {
  return recordOf(config, await pick(config, ref))
}

export async function showCommand(ctx: Ctx, refs: string[]): Promise<number> {
  const { config } = ctx
  if (ctx.flags.out !== undefined && !ctx.flags.trace)
    throw new CommandError('--out is where --trace writes its file: add --trace')
  if (ctx.flags.trace && (ctx.flags.json || ctx.flags.md))
    throw new CommandError('reeval show takes --trace, --json or --md, one at a time')
  const entries = await allRuns(config)
  const ref = refs[0]
  if (ref && !entries.some((e) => e.runId.startsWith(ref))) {
    const { listLive } = await import('./studio/live.ts')
    const live = (
      await listLive({ root: config.root, historyDir: config.history.dir, scratch: true })
    ).find((r) => r.runId.startsWith(ref))
    if (live)
      throw new CommandError(
        live.state === 'stopped'
          ? `${live.runId} stopped without writing a record: reeval run --resume ${live.runId} finishes it, then reeval show reads it.`
          : `${live.runId} is still running: reeval show reads the record it writes when it ends. reeval studio shows it live.`,
      )
  }
  const entry = await pick(config, ref, entries)
  const dir = entry.recorded ? config.history.dir : scratchDir(config.root)
  const run = await readRecord(join(dir, `${entry.runId}.json`))
  if (ctx.flags.trace) {
    const { runTrace } = await import('./history/trace.ts')
    const { transcriptLines } = await import('./mcp/files.ts')
    const transcripts = new Map<string, TranscriptLine[]>()
    for (const a of run.evals.flatMap((e) => e.attempts)) {
      const lines = a.startedAt ? await transcriptLines(config, run, a) : null
      if (lines) transcripts.set(a.key, lines)
    }
    const file = resolve(
      ctx.flags.out ?? join(config.root, '.reeval', 'traces', `${run.runId}.json`),
    )
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(runTrace(run, transcripts))}\n`)
    ctx.out(`Wrote ${fromCwd(file)}: open it at https://ui.perfetto.dev (Open trace file)`)
    return 0
  }
  if (ctx.flags.json) {
    ctx.out(JSON.stringify(run, null, 2))
    return 0
  }
  const remarks = await readRemarks(runRemarksFile(config, entry))
  if (ctx.flags.md) {
    const artifactDir = runDir(dir, entry.runId)
    const inputs = await readReportInputs(artifactDir)
    ctx.out(renderSummary(run, { ...inputs, remarks: inputs.remarks ?? remarks }).trimEnd())
  } else ctx.out(formatShow(run, { remarks }))
  return 0
}

/**
 * Two runs and their rows: `base` and `head` when both are given, else `head` (default latest)
 * against its nearest recorded ancestor. `json` is what `reeval compare --json` prints.
 */
export async function compareView(config: ResolvedConfig, refs: string[]) {
  const { root } = config
  // Every recorded run: a pair named by id, or head's recorded ancestor, may be on another branch.
  const entries = await allRuns(config, false)
  let base: HistoryEntry | null
  let head: HistoryEntry
  let reach: Reachability
  if (refs.length >= 2) {
    base = resolveRun(entries, refs[0])
    head = resolveRun(entries, refs[1])
    reach = await reachability(root, [base.git?.sha, head.git?.sha])
  } else {
    head = await pick(config, refs[0] ?? 'latest')
    reach = await reachability(root, [head.git?.sha])
    // Ancestry of head's commit, or of HEAD when that commit was rebased away.
    const from = head.git && (!reach || reach.has(head.git.sha)) ? head.git.sha : 'HEAD'
    const ancestry = await lines(root, ['rev-list', '--max-count=5000', from])
    const candidates = entries.filter((e) => e.recorded && e.runId !== head.runId)
    base = pickBaseline(candidates, head, ancestry)
    await settle(root, reach, [base?.git?.sha])
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
        cost: runCost(record.cost),
      }
    }
    const changes = base ? stackChanges(base, head) : []
    const input = {
      base: base ? await side(base) : null,
      head: await side(head),
      rows,
      changes,
    }
    const opts = { color: false, verbose: !!ctx.flags.verbose?.length }
    if (ctx.flags.md) {
      const headRecord = await recordOf(ctx.config, head)
      const baseRecord = base ? await recordOf(ctx.config, base) : null
      const headDir = runDir(
        head.recorded ? ctx.config.history.dir : scratchDir(ctx.config.root),
        head.runId,
      )
      const inputs = await readReportInputs(headDir)
      ctx.out(
        renderSummary(headRecord, {
          ...inputs,
          prior: baseRecord ? { record: baseRecord, rows, changes } : null,
        }).trimEnd(),
      )
    } else ctx.out(renderCompare(input, opts).join('\n'))
  }
  return ctx.flags['fail-on-regression'] && failing.length ? 1 : 0
}

/**
 * What `--fail-on-regression` fails on: an eval that regressed (went from pass to fail, or has a
 * case that did outside a pooled gate), and a new or changed (can't compare) one that fails, since
 * nothing earlier vouches for it. A head the run's interrupt canceled didn't fail.
 */
export const regressions = (rows: CompareRow[]) =>
  rows.filter(
    (r) =>
      r.status === 'regressed' ||
      ((r.status === 'added' || r.status === 'drift') &&
        r.head === 'fail' &&
        !r.canceled?.includes('head')),
  )

/** Fetches a commit from `origin` (a run recorded on another machine, or a branch not fetched). */
async function fetched(root: string, sha: string, present: () => Promise<boolean>) {
  if ((await git(root, ['remote', 'get-url', 'origin'])).code !== 0) return false
  if ((await git(root, ['fetch', '--quiet', 'origin', sha])).code !== 0) return false
  return present()
}

/** Recreates the state a run executed in: its commit, plus its uncommitted changes if any. */
export async function checkoutCommand(ctx: Ctx, args: string[]): Promise<number> {
  const { root } = ctx.config
  const entry = await pick(ctx.config, args[0] ?? 'latest')
  const dir = entry.recorded ? ctx.config.history.dir : scratchDir(root)
  const run = await readRecord(join(dir, `${entry.runId}.json`))
  if (!run.git) throw new CommandError(`${run.runId} didn't run in a git repository`)
  const { sha } = run.git
  const present = async () => (await git(root, ['cat-file', '-e', `${sha}^{commit}`])).code === 0
  if (!(await present()) && !(await fetched(root, sha, present))) {
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
        `${rel(patchPath)} is missing, but the record says the run's uncommitted changes are in it. ${entry.recorded ? (isRemote(ctx.config.history) ? `Delete ${rel(ctx.config.history.dir)} and reeval sync downloads the store's runs again.` : "Restore it from git, where it's committed with the record, then try again.") : "It's gone from .reeval/runs, so those changes can't be recreated."}`,
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
