// The engine's main process: finds the eval files, collects each in a fresh worker for the plan,
// then runs each in a fresh worker again, at most one per CPU at once, handing out the
// scheduler's leases over IPC and turning what workers report into ES's events and results.
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { UsageError } from '../errors.ts'
import { attemptKey, evalId, relativeFile } from '../ids.ts'
import { ownVersion, PACKAGE_DIR, PACKAGE_NAMES } from '../root.ts'
import { Scheduler } from '../scheduler/core.ts'
import { capMiddle } from '../text.ts'
import { esFrames, formatError, type SerializedError } from './errors.ts'
import { DEFAULT_EXCLUDE, filterFiles, findEvalFiles, matchesFilter } from './files.ts'
import {
  describeExit,
  eachLimited,
  forkWorker,
  handshake,
  type Spawn,
  type WorkerProcess,
  workerEntry,
} from './pool.ts'
import type { FromWorker, WireResult, WireTest } from './protocol.ts'
import type {
  CollectedPlan,
  EngineEval,
  EngineOptions,
  EngineRun,
  ExcludedEval,
  PlannedItem,
} from './types.ts'

export type {
  CollectedPlan,
  EngineEval,
  EngineOptions,
  EngineRun,
  ExcludedEval,
  PlannedItem,
} from './types.ts'

/** What runs eval files, for the record. */
export const engineVersions: Record<string, string> = {
  '@vitest/expect': ownVersion('@vitest/expect'),
  jiti: ownVersion('jiti'),
}

const onlyInCi = (file: string) =>
  `evaluate.only/group.only in ${file} isn't allowed in CI (CI is set). Remove it, or run with CI=false.`

type Collected = { file: string; rel: string; tests: WireTest[] }

export async function runEngine(
  options: EngineOptions,
  spawn: Spawn = forkWorker,
): Promise<EngineRun> {
  const { config, concurrency } = options.run
  const root = config.root
  const files = await findEvalFiles(root, config.include, [
    ...DEFAULT_EXCLUDE,
    '**/.es/**',
    `${relativeFile(root, config.history.dir)}/**`,
  ])
  // A part that names an eval file picks files; any other part picks evals by name or cell.
  // Parts of one kind widen the selection, and the two kinds narrow each other.
  const pathFilters = options.filters.filter((f) => filterFiles(files, [f], root).length)
  const nameFilters = options.filters.filter((f) => !pathFilters.includes(f))
  const specs = filterFiles(files, pathFilters, root)
  if (specs.length === 0)
    return { evals: [], unhandledErrors: [], cancelled: false, noFiles: true, stopped: false }

  // Attempts wait on the network, not the CPU, so a few workers run many attempts each.
  const workers = Math.max(1, Math.min(concurrency, availableParallelism()))
  const entry = workerEntry(root, PACKAGE_NAMES)
  const hide = [...esFrames(PACKAGE_DIR), ...esFrames(join(entry, '..', '..'))]
  const matchesName = (e: { id: string; attempt?: EngineEval['attempt'] }) =>
    nameFilters.length === 0 || nameFilters.some((f) => matchesFilter(e, f))
  const run = options.run

  // Collect: each file in a worker of its own, for the plan.
  const collected: Collected[] = []
  const failed = new Map<string, string[]>()
  let usage: string | undefined
  await eachLimited(specs, workers, async (file) => {
    const rel = relativeFile(root, file)
    const worker = spawn(entry, root)
    let tests: WireTest[] | undefined
    let error: SerializedError | undefined
    worker.onMessage((m) => {
      if (m.t === 'collected') tests = m.tests
      else if (m.t === 'load-error') error = m.error
    })
    await handshake(worker, entry)
    worker.send({ t: 'init', run, file, select: null })
    const exit = await worker.exited
    if (tests) collected.push({ file, rel, tests })
    else if (error?.name === 'OnlyInCiError') usage = onlyInCi(rel)
    else if (error?.name === 'UsageError' || error?.name === 'DefinitionError')
      usage = `${rel}: ${error.message}`
    else {
      const message = error
        ? stripVTControlCharacters(String(error.message)).trim()
        : `the worker exited while loading it (${describeExit(exit)})`
      failed.set(message, [...(failed.get(message) ?? []), rel])
    }
  })
  if (usage) throw new UsageError(usage)
  // A file that fails to load registers none of its evals: running the rest would drop them.
  if (failed.size) {
    const lines = [...failed]
      .map(([message, rels]) => `${rels.sort().join(', ')}: ${message}`)
      .sort()
    const count = [...failed.values()].flat().length
    throw new UsageError(
      `${count === 1 ? 'An eval file' : `${count} eval files`} failed to load:\n${lines.join('\n')}`,
    )
  }
  collected.sort((a, b) => Number(a.file > b.file) - Number(a.file < b.file))

  if (options.onPlan) {
    const plan = collectPlan(collected, matchesName, nameFilters)
    // When no part matched anything, the run's own "no evals matched" says so.
    if (plan.unmatched.length === options.filters.length) plan.unmatched = []
    if (!(await options.onPlan(plan)))
      return { evals: [], unhandledErrors: [], cancelled: false, noFiles: false, stopped: true }
  }

  // With a name filter, only the files it picks an eval in run.
  const picked = nameFilters.length
    ? collected.filter(({ rel, tests }) => tests.some((t) => matchesName(identify(rel, t))))
    : collected
  if (picked.length === 0)
    return { evals: [], unhandledErrors: [], cancelled: false, noFiles: true, stopped: false }
  return runFiles({ ...options, spawn, entry, hide, workers, collected: picked, matchesName })
}

/** Who a collected test is: its eval id, attempt key, groups and name. */
function identify(rel: string, test: WireTest) {
  const { attempt } = test
  const group = attempt?.groups ?? test.groups
  const name = attempt?.name ?? test.name
  const id = evalId(rel, [...group, name])
  const key = attempt ? attemptKey(id, attempt.cell.key, attempt.n) : id
  return { id, key, file: rel, group, name, attempt }
}

const skipped = (test: WireTest) => test.mode === 'skip' || test.mode === 'todo'

/**
 * The attempts collected files would start, by file then as declared, and the evals left out.
 * Evals a tag filter dropped never registered, so they're in neither list.
 */
function collectPlan(
  collected: Collected[],
  matchesName: (e: ReturnType<typeof identify>) => boolean,
  nameFilters: readonly string[],
): CollectedPlan {
  const planned: PlannedItem[] = []
  const excluded = new Map<string, ExcludedEval>()
  const unmatched = new Set(nameFilters)
  let matched = 0
  for (const { rel, tests } of collected) {
    for (const test of tests) {
      const e = identify(rel, test)
      for (const f of unmatched) if (matchesFilter(e, f)) unmatched.delete(f)
      if (!matchesName(e)) continue
      matched++
      const { attempt } = e
      if (attempt?.plan.skip || (attempt && !skipped(test))) {
        planned.push({ id: e.id, key: e.key, file: e.file, attempt })
      } else if (!excluded.has(e.id)) {
        excluded.set(e.id, { id: e.id, mode: test.mode === 'todo' ? 'todo' : 'skip' })
      }
    }
  }
  return { planned, excluded: [...excluded.values()], matched, unmatched: [...unmatched] }
}

type RunInput = EngineOptions & {
  spawn: Spawn
  entry: string
  hide: string[]
  workers: number
  collected: Collected[]
  matchesName: (e: ReturnType<typeof identify>) => boolean
}

type FileRun = {
  rel: string
  tests: WireTest[]
  results: Map<number, EngineEval>
}

/** Runs every file in a fresh worker, at most `workers` at once, and gathers the results. */
async function runFiles(input: RunInput): Promise<EngineRun> {
  const { run, entry, hide, workers, collected, matchesName } = input
  const specs = collected.map((c) => c.file)
  const root = run.config.root
  const emit = input.onEvent ?? (() => {})
  const unhandledErrors: string[] = []
  const live = new Set<WorkerProcess>()
  const byFile = new Map<string, FileRun>()
  // Every file in the first round asks for its leases before any is granted, so the first
  // file's attempts don't take every slot just because its worker started first.
  const owners = new Map<string, WorkerProcess>()
  const scheduler = new Scheduler((request) => {
    owners
      .get(request.owner)
      ?.send({ t: 'grant', id: request.id.slice(request.id.indexOf(':') + 1) })
  })
  let gathering = Math.min(specs.length, workers)
  if (gathering > 1) scheduler.pause()
  const gathered = () => {
    if (--gathering === 0) scheduler.resume()
  }

  let cancelled = false
  input.onCancellable?.(() => {
    cancelled = true
    scheduler.resume()
    for (const worker of live) worker.send({ t: 'cancel' })
  })

  const toEval = (rel: string, test: WireTest, result: WireResult): EngineEval => ({
    ...identify(rel, test),
    state: result.state,
    durationMs: Math.round(result.durationMs),
    errors: result.errors.map((e) => capMiddle(String(e.message))),
    formattedErrors: result.errors.map((e) =>
      capMiddle(formatError(e, { root, hide, columns: process.stdout.columns })),
    ),
    meta: result.meta,
    ...(test.mode === 'todo' ? { todo: true as const } : {}),
  })

  input.onRunStart?.(specs.length)
  let owner = 0
  await eachLimited(
    collected,
    workers,
    async ({ file, rel, tests: planned }) => {
      const id = String(++owner)
      const worker = input.spawn(entry, root)
      live.add(worker)
      owners.set(id, worker)
      const state: FileRun = { rel, tests: [], results: new Map() }
      byFile.set(file, state)
      let done = false
      let ready = false
      const markReady = () => {
        if (ready) return
        ready = true
        gathered()
      }
      const keyOf = (index: number | undefined) =>
        index === undefined || !state.tests[index]
          ? undefined
          : identify(rel, state.tests[index]).key
      // What an eval writes to process.stdout or stderr directly, as under Vitest, only shows
      // with ES_DEBUG; console output reaches its attempt.
      worker.onOutput((_stream, text) => {
        if (process.env.ES_DEBUG) process.stderr.write(text)
      })
      worker.onMessage((m: FromWorker) => {
        switch (m.t) {
          case 'collected': {
            state.tests = m.tests
            emit({
              type: 'collected',
              at: Date.now(),
              file: rel,
              evals: m.tests.map((test) => {
                const e = identify(rel, test)
                return {
                  id: e.id,
                  key: e.key,
                  group: e.group,
                  name: e.name,
                  skipped: skipped(test) || !matchesName(e),
                }
              }),
            })
            break
          }
          case 'load-error':
            unhandledErrors.push(
              `${rel}: ${stripVTControlCharacters(String(m.error.message)).trim()}`,
            )
            break
          case 'request':
            scheduler.request({
              id: `${id}:${m.id}`,
              owner: id,
              limits: m.limits,
              ...(m.rank ? { rank: m.rank } : {}),
            })
            break
          case 'release':
            scheduler.release(`${id}:${m.id}`)
            break
          case 'ready':
            markReady()
            break
          case 'start': {
            const test = state.tests[m.index] as WireTest
            const { id: evalKey, key, attempt } = identify(rel, test)
            emit({ type: 'eval-start', at: m.at, id: evalKey, key, attempt })
            break
          }
          case 'progress':
            emit({ type: 'eval-progress', key: keyOf(m.index) as string, progress: m.progress })
            break
          case 'debug':
            emit({ type: 'debug', key: keyOf(m.index) as string, line: m.line })
            break
          case 'log': {
            const key = keyOf(m.index)
            emit({ type: 'log', at: m.at, ...(key ? { key } : {}), stream: m.stream, text: m.text })
            break
          }
          case 'result': {
            // As under Vitest, an attempt a cancel cut short is skipped; its record says aborted.
            const result: WireResult =
              cancelled && m.result.state === 'failed'
                ? { ...m.result, state: 'skipped' }
                : m.result
            const e = toEval(rel, state.tests[m.index] as WireTest, result)
            state.results.set(m.index, e)
            if (matchesName(e)) emit({ type: 'eval-end', at: Date.now(), result: e })
            break
          }
          case 'meta': {
            const e = state.results.get(m.index)
            if (e) e.meta = m.meta
            break
          }
          case 'unhandled':
            unhandledErrors.push(String(m.error.message ?? m.error))
            break
          case 'done':
            done = true
            break
        }
      })
      try {
        await handshake(worker, entry)
      } catch (error) {
        live.delete(worker)
        markReady()
        throw error
      }
      const select = planned.filter((t) => matchesName(identify(rel, t))).map((t) => t.index)
      worker.send({ t: 'init', run, file, select })
      if (cancelled) worker.send({ t: 'cancel' })
      const exit = await worker.exited
      live.delete(worker)
      scheduler.releaseOwner(id)
      markReady()
      if (done) return
      // The worker died mid-file (killed, out of memory): its unfinished attempts fail.
      const why = `The worker running ${rel} exited unexpectedly (${describeExit(exit)})`
      unhandledErrors.push(why)
      for (const test of state.tests) {
        if (state.results.has(test.index) || skipped(test) || !matchesName(identify(rel, test)))
          continue
        const e = toEval(rel, test, {
          state: 'failed',
          errors: [{ name: 'Error', message: why }],
          durationMs: 0,
        })
        state.results.set(test.index, e)
        emit({ type: 'eval-end', at: Date.now(), result: e })
      }
    },
    () => !cancelled,
  )

  // Attempts finish in any order; results are listed by file, then as declared.
  const evals: EngineEval[] = []
  for (const file of [...byFile.keys()].sort()) {
    const { rel, tests, results } = byFile.get(file) as FileRun
    for (const test of tests) {
      const e =
        results.get(test.index) ??
        toEval(rel, test, { state: 'skipped', errors: [], durationMs: 0 })
      if (matchesName(e)) evals.push(e)
    }
  }
  return { evals, unhandledErrors, cancelled, noFiles: false, stopped: false }
}
