// The run-history commands: publish, pull, index, history, show, compare.
import { git } from './git.ts'
import { runDir } from './ids.ts'
import { buildIndex, deriveStore, INDEX_PATH, parseIndex, parseRun } from './record/index-file.ts'
import type { IndexEntry } from './record/types.ts'
import {
  compare,
  formatCompare,
  formatHistory,
  formatShow,
  history,
  pickBaseline,
  resolveRun,
} from './record/views.ts'
import { gitBranchStore } from './store/git.ts'
import { type LocalStore, localStore } from './store/local.ts'
import { publishRuns, pullRuns } from './store/sync.ts'
import type { ResultsStore } from './store/types.ts'
import type { ResultsConfig } from './types.ts'

export type HistoryFlags = {
  json?: boolean
  md?: boolean
  remote?: string
  branch?: string
  'allow-dirty'?: boolean
  'allow-incomplete'?: boolean
  'skip-secret-scan'?: boolean
  run?: string[]
  full?: boolean
  limit?: string
  rebuild?: boolean
  'fail-on-regression'?: boolean
}

export class CommandError extends Error {
  override name = 'CommandError'
}

type Ctx = { root: string; results: ResultsConfig; flags: HistoryFlags; out: (s: string) => void }

/** The local index, rebuilt if it's missing or stale (e.g. written by an older ES). */
async function localEntries(local: LocalStore): Promise<IndexEntry[]> {
  const index = parseIndex(await local.get(INDEX_PATH))
  if (index) return index.runs
  const rebuilt = await buildIndex(local, null)
  if (rebuilt.runs.length > 0) {
    await local.commit({ files: new Map(), derive: deriveStore, message: 'es: index' })
  }
  return rebuilt.runs
}

function teamStore({ root, results, flags }: Ctx): ResultsStore {
  if (flags.remote) return gitBranchStore({ remote: flags.remote, branch: flags.branch, root })
  if (flags.branch) return gitBranchStore({ branch: flags.branch, root })
  if (results.store) return results.store
  throw new CommandError(
    'No results store configured. Set results.store in es.config.ts (e.g. gitBranchStore()), or pass --remote <url|path|name>.',
  )
}

const describe = (store: ResultsStore) =>
  Object.entries(store.describe())
    .map(([k, v]) => (k === 'kind' ? v : `${k} ${v}`))
    .join(' · ')

export async function publishCommand(ctx: Ctx, refs: string[]): Promise<number> {
  const local = localStore({ root: ctx.root })
  const entries = await localEntries(local)
  const runIds = [
    ...new Set((refs.length ? refs : ['latest']).map((r) => resolveRun(entries, r).runId)),
  ]
  const target = teamStore(ctx)
  const result = await publishRuns(local, target, runIds, {
    allowDirty: ctx.flags['allow-dirty'],
    allowIncomplete: ctx.flags['allow-incomplete'],
    skipSecretScan: ctx.flags['skip-secret-scan'],
  })
  if (ctx.flags.json) {
    ctx.out(JSON.stringify({ store: target.describe(), ...result }, null, 2))
    return 0
  }
  const what = runIds.length === 1 ? `run ${runIds[0]}` : `${runIds.length} runs`
  if (!result.changed) ctx.out(`${what} already published to ${describe(target)}`)
  else {
    const retries = result.attempts > 1 ? ` after ${result.attempts} attempts` : ''
    ctx.out(`published ${what} (${result.created.length} files) to ${describe(target)}${retries}`)
  }
  return 0
}

export async function pullCommand(ctx: Ctx): Promise<number> {
  const local = localStore({ root: ctx.root })
  const source = teamStore(ctx)
  const result = await pullRuns(source, local, { runs: ctx.flags.run, full: ctx.flags.full })
  if (ctx.flags.json) ctx.out(JSON.stringify(result, null, 2))
  else if (result.runs.length === 0) ctx.out(`up to date with ${describe(source)}`)
  else {
    ctx.out(
      `pulled ${result.runs.length} run${result.runs.length === 1 ? '' : 's'} (${result.files} files${ctx.flags.full ? '' : ', records only; --full for transcripts'}) from ${describe(source)}`,
    )
  }
  return 0
}

export async function indexCommand(ctx: Ctx): Promise<number> {
  const local = localStore({ root: ctx.root })
  const index = await buildIndex(
    local,
    ctx.flags.rebuild ? null : parseIndex(await local.get(INDEX_PATH)),
  )
  await local.commit({
    files: new Map(),
    derive: async (view) => {
      const derived = await deriveStore(view)
      if (ctx.flags.rebuild)
        derived.set(INDEX_PATH, Buffer.from(`${JSON.stringify(index, null, 2)}\n`))
      return derived
    },
    message: 'es: index',
  })
  ctx.out(`indexed ${index.runs.length} run${index.runs.length === 1 ? '' : 's'} in ${local.dir}`)
  return 0
}

export async function historyCommand(ctx: Ctx, filter: string[]): Promise<number> {
  const entries = await localEntries(localStore({ root: ctx.root }))
  const limit = ctx.flags.limit ? Number(ctx.flags.limit) : 20
  if (!(limit > 0)) throw new CommandError('--limit must be a positive number')
  const view = history(entries, { filter: filter.join(' ') || undefined, limit })
  ctx.out(ctx.flags.json ? JSON.stringify(view, null, 2) : formatHistory(view))
  return 0
}

export async function showCommand(ctx: Ctx, refs: string[]): Promise<number> {
  const local = localStore({ root: ctx.root })
  const entry = resolveRun(await localEntries(local), refs[0])
  const file = ctx.flags.md ? 'summary.md' : 'run.json'
  const bytes = await local.get(`${runDir(entry.runId)}/${file}`)
  if (!bytes)
    throw new CommandError(`${entry.runId} has no ${file} locally; es pull --run ${entry.runId}`)
  const text = Buffer.from(bytes).toString('utf8')
  if (ctx.flags.md || ctx.flags.json) ctx.out(text.trimEnd())
  else ctx.out(formatShow(parseRun(bytes, entry.path)))
  return 0
}

/** First-parent commits from `sha` back, or null when git can't say (not a repo, shallow). */
async function ancestry(root: string, sha: string): Promise<string[] | null> {
  const r = await git(root, ['rev-list', '--first-parent', '--max-count=500', sha])
  if (r.code !== 0) return null
  return r.stdout.toString('utf8').split('\n').filter(Boolean)
}

export async function compareCommand(ctx: Ctx, refs: string[]): Promise<number> {
  const entries = await localEntries(localStore({ root: ctx.root }))
  let base: IndexEntry | null
  let head: IndexEntry
  if (refs.length >= 2) {
    base = resolveRun(entries, refs[0])
    head = resolveRun(entries, refs[1])
  } else {
    head = resolveRun(entries, refs[0] ?? 'latest')
    base = pickBaseline(entries, head, head.git ? await ancestry(ctx.root, head.git.sha) : null)
    if (!base) throw new CommandError(`No earlier complete run to compare ${head.runId} with`)
  }
  const rows = compare(base, head)
  if (ctx.flags.json) {
    ctx.out(JSON.stringify({ base: base.runId, head: head.runId, rows }, null, 2))
  } else ctx.out(formatCompare(base, head, rows, !!ctx.flags.md))
  return ctx.flags['fail-on-regression'] && rows.some((r) => r.status === 'regressed') ? 1 : 0
}
