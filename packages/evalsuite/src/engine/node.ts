// Main-process half of the engine adapter: embeds Vitest and translates its reporter events
// into ES types. Nothing here leaks Vitest types to callers.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import { join, sep } from 'node:path'
import { Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { configDefaults } from 'vitest/config'
import {
  createVitest,
  type Reporter,
  type TestCase,
  type TestModule,
  type Vitest,
} from 'vitest/node'
import { inCI } from '../env.ts'
import { UsageError } from '../errors.ts'
import { attemptKey, evalId, relativeFile } from '../ids.ts'
import { DIST_DIR, PACKAGE_DIR } from '../root.ts'
import { type SchedulerServer, startSchedulerServer } from '../scheduler/server.ts'
import type { AttemptMeta, RunContext } from '../types.ts'
import type { EsEvent, EvalResult } from '../ui/events.ts'
import { cancelMarker } from './cancel.ts'
import type {} from './runtime.ts'

/** One attempt: a Vitest test. */
export type EngineEval = EvalResult

export type EngineRun = {
  evals: EngineEval[]
  unhandledErrors: string[]
  cancelled: boolean
  noFiles: boolean
  /** `onPlan` said not to run, e.g. for `--dry-run`. */
  stopped: boolean
}

/** One planned attempt, from collecting the eval files without running them. */
export type PlannedItem = { id: string; key: string; file: string; attempt: AttemptMeta }

/** An eval collection left out: `.skip`, `.todo`, or a sibling of an `.only`. */
export type ExcludedEval = { id: string; mode: 'skip' | 'todo' }

/**
 * What a run would start, from collecting the eval files; `matched` counts filter hits, and
 * `unmatched` lists the name or cell filter parts that matched no eval while others did.
 */
export type CollectedPlan = {
  planned: PlannedItem[]
  excluded: ExcludedEval[]
  matched: number
  unmatched: string[]
}

export type EngineOptions = {
  run: RunContext
  filters: string[]
  /** Called once the eval files are known, with how many there are. */
  onRunStart?: (files: number) => void
  /** Collection, start, progress, console output and result of each attempt, as they happen. */
  onEvent?: (e: EsEvent) => void
  /** Called once the engine can be cancelled, with a function that cancels the run. */
  onCancellable?: (cancel: () => void) => void
  /**
   * Called with every attempt the run would start, after collecting the files and before any
   * attempt runs. Resolve false to stop there; throw to fail the run.
   */
  onPlan?: (collected: CollectedPlan) => Promise<boolean>
}

const require = createRequire(import.meta.url)
export const vitestVersion: string = require('vitest/package.json').version
export const engineVersions = { vitest: vitestVersion }
const packageName: string = require(join(PACKAGE_DIR, 'package.json')).name

const esDistDir = `${DIST_DIR}${sep}`
// ES's own frames (src/ via source maps, or dist/) are noise in an eval's stack trace.
const esDirs = [join(PACKAGE_DIR, 'src', sep), esDistDir]
// Workers load ES's built modules natively, as they do from node_modules once ES is installed.
// From a workspace checkout Vitest would otherwise transform them under their own file URLs,
// which V8 coverage can't map back to the files.
const esDist = new RegExp(`^${esDistDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)

const silentLogger = {
  hasWarned: false,
  info() {},
  warn() {},
  warnOnce() {},
  error() {},
  clearScreen() {},
  hasErrorLogged: () => false,
}

class Capture extends Writable {
  text = ''
  override _write(chunk: Buffer, _enc: string, done: () => void) {
    this.text += chunk
    if (process.env.ES_DEBUG) process.stderr.write(chunk)
    done()
  }
}

/** Rewrites the few runtime messages that name Vitest options. */
const cleanMessage = (message: string) =>
  message
    .replace(
      /Test timed out in (\d+)ms\.[\s\S]*/,
      (_, ms) => `Eval timed out after ${Number(ms) / 1000}s`,
    )
    .replace(/\n?If this is a long-running test[\s\S]*/, '')

function groupPath(test: TestCase): string[] {
  const path: string[] = []
  for (let p = test.parent; p.type === 'suite'; p = p.parent) path.unshift(p.name)
  return path
}

function identify(root: string, test: TestCase) {
  const file = relativeFile(root, test.module.moduleId)
  const attempt = test.meta().esAttempt
  const group = attempt?.groups ?? groupPath(test)
  const name = attempt?.name ?? test.name
  const id = evalId(file, [...group, name])
  const key = attempt ? attemptKey(id, attempt.cell.key, attempt.n) : id
  return { file, attempt, group, name, id, key }
}

function toEngineEval(root: string, test: TestCase, vitest?: Vitest): EngineEval {
  const { file, attempt, group, name, id, key } = identify(root, test)
  const result = test.result()
  const state =
    result.state === 'failed' ? 'failed' : result.state === 'passed' ? 'passed' : 'skipped'
  const errors = result.errors ?? []
  const format = (e: (typeof errors)[number]) =>
    vitest?.logger.formatError(e, { project: test.project, showCodeFrame: true }).output ?? ''
  return {
    id,
    key,
    file,
    group,
    name,
    attempt,
    state,
    durationMs: Math.round(test.meta().esRunMs ?? test.diagnostic()?.duration ?? 0),
    errors: errors.map((e) => cleanMessage(e.message ?? String(e))),
    formattedErrors: vitest ? errors.map(format) : [],
    meta: test.meta().es,
  }
}

const ONLY_IN_CI = /Unexpected \.only modifier/
const onlyInCi = (file: string) =>
  `evaluate.only/group.only in ${file} isn't allowed in CI (CI is set). Remove it, or run with CI=false.`

/** A usage mistake an eval file made while registering (exit 2), and any other module errors. */
function moduleProblems(root: string, modules: readonly TestModule[]) {
  let usage: string | undefined
  const unhandled: string[] = []
  /** Files that failed to load, by error: one bad tsconfig fails every file the same way. */
  const failed = new Map<string, string[]>()
  for (const module of modules) {
    const file = relativeFile(root, module.moduleId)
    for (const test of module.children.allTests()) {
      if ((test.result().errors ?? []).some((e) => ONLY_IN_CI.test(e.message ?? ''))) {
        usage = onlyInCi(file)
      }
    }
    for (const error of module.errors()) {
      if (error.name === 'OnlyInCiError' || ONLY_IN_CI.test(error.message)) {
        usage = onlyInCi(file)
      } else if (error.name === 'UsageError' || error.name === 'DefinitionError') {
        usage = `${file}: ${error.message}`
      } else {
        const message = stripVTControlCharacters(cleanMessage(error.message)).trim()
        unhandled.push(`${file}: ${message}`)
        failed.set(message, [...(failed.get(message) ?? []), file])
      }
    }
  }
  return { usage, unhandled, failed }
}

/**
 * Evals register through the `evalsuite` the project resolves, so that copy must run on this
 * engine's Vitest; two copies break registration. A project's own Vitest, for its own tests,
 * is never loaded and doesn't matter. ES depends on a patch range of vitest, but a compatible
 * version isn't enough: registration lives in module state, so even the same version installed
 * twice registers nothing. Only the copy counts.
 */
export function vitestMismatch(root: string): string | undefined {
  const theirs = [...new Set([packageName, 'evalsuite'])]
    .map((name) => {
      try {
        const evalsuite = createRequire(`${root}/`).resolve(`${name}/package.json`)
        return createRequire(evalsuite).resolve('vitest/package.json')
      } catch {
        return undefined
      }
    })
    .find((path) => path !== undefined)
  if (!theirs) return undefined
  const ours = require.resolve('vitest/package.json')
  if (realpathSync(theirs) === realpathSync(ours)) return undefined
  const version = (path: string): string => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')).version ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }
  return `The evalsuite this project resolves uses another copy of vitest (${version(theirs)} at ${theirs}) than this es (${vitestVersion} at ${ours}), so its evals won't register. Run the project's own es, e.g. npx es.`
}

const skipped = (test: TestCase) => test.options.mode === 'skip' || test.options.mode === 'todo'

/**
 * The attempts collected modules would start, by file then as declared, and the evals left out.
 * Evals a tag filter dropped never registered, so they're in neither list.
 */
function collectPlan(
  root: string,
  modules: readonly TestModule[],
  matchesName: (e: EngineEval) => boolean,
  nameFilters: readonly string[],
): CollectedPlan {
  const problems = moduleProblems(root, modules)
  if (problems.usage) throw new UsageError(problems.usage)
  // A file that fails to load registers none of its evals: running the rest would drop them.
  if (problems.failed.size) {
    const lines = [...problems.failed]
      .map(([message, files]) => `${files.sort().join(', ')}: ${message}`)
      .sort()
    const count = [...problems.failed.values()].flat().length
    throw new UsageError(
      `${count === 1 ? 'An eval file' : `${count} eval files`} failed to load:\n${lines.join('\n')}`,
    )
  }
  const tests = [...modules]
    .sort((a, b) => (a.moduleId < b.moduleId ? -1 : 1))
    .flatMap((m) => [...m.children.allTests()])
  const planned: PlannedItem[] = []
  const excluded = new Map<string, ExcludedEval>()
  const unmatched = new Set(nameFilters)
  let matched = 0
  for (const test of tests) {
    const e = toEngineEval(root, test)
    for (const f of unmatched) if (nameText(e).includes(f)) unmatched.delete(f)
    if (!matchesName(e)) continue
    matched++
    const { attempt } = e
    if (attempt?.plan.skip || (attempt && !skipped(test))) {
      planned.push({ id: e.id, key: e.key, file: e.file, attempt })
    } else if (!excluded.has(e.id)) {
      excluded.set(e.id, { id: e.id, mode: test.options.mode === 'todo' ? 'todo' : 'skip' })
    }
  }
  return { planned, excluded: [...excluded.values()], matched, unmatched: [...unmatched] }
}

/** What a name or cell filter matches: the groups, the eval's name and `[cell#n]`. */
const nameText = (e: EngineEval) =>
  [...e.group, e.name, e.attempt ? `[${e.attempt.cell.key}#${e.attempt.n}]` : ''].join(' ')

export async function runEngine(options: EngineOptions): Promise<EngineRun> {
  const { config } = options.run
  const evals = new Map<string, EngineEval>()
  let unhandledErrors: string[] = []
  let cancelled = false
  let usage: string | undefined

  // Collecting for the plan runs the same reporter hooks; only the real run reports.
  let collecting = false
  const onEvent = options.onEvent ?? (() => {})
  const emit = (e: EsEvent) => {
    if (!collecting) onEvent(e)
  }
  const keysByTask = new Map<string, string>()
  const reporter: Reporter = {
    onTestRunStart(specifications) {
      if (!collecting) options.onRunStart?.(specifications.length)
    },
    onTestModuleCollected(module) {
      if (collecting) return
      const tests = [...module.children.allTests()].map((test) => ({
        test,
        ...identify(config.root, test),
      }))
      for (const t of tests) keysByTask.set(t.test.id, t.key)
      scheduler?.expect(tests.filter((t) => !skipped(t.test)).length)
      emit({
        type: 'collected',
        at: Date.now(),
        file: relativeFile(config.root, module.moduleId),
        evals: tests.map((t) => ({
          id: t.id,
          key: t.key,
          group: t.group,
          name: t.name,
          skipped: skipped(t.test),
        })),
      })
    },
    // An attempt starts when the scheduler lets it, not when Vitest calls its test.
    onTestCaseArtifactRecord(test, artifact) {
      if (artifact.type === 'es:start') {
        const { id, key, attempt } = identify(config.root, test)
        emit({ type: 'eval-start', at: artifact.at, id, key, attempt })
      } else if (artifact.type === 'es:progress') {
        const { key } = identify(config.root, test)
        emit({ type: 'eval-progress', key, progress: artifact.progress })
      } else if (artifact.type === 'es:debug') {
        const { key } = identify(config.root, test)
        emit({ type: 'debug', key, line: artifact.line })
      } else if (artifact.type === 'es:log') {
        const { key } = identify(config.root, test)
        emit({ type: 'log', at: artifact.at, key, stream: artifact.stream, text: artifact.text })
      }
    },
    onUserConsoleLog(log) {
      const key = log.taskId ? keysByTask.get(log.taskId) : undefined
      emit({
        type: 'log',
        at: log.time,
        ...(key ? { key } : {}),
        stream: log.type,
        text: log.content,
      })
    },
    onTestCaseResult(test) {
      if (collecting) return
      const e = toEngineEval(config.root, test, vitest)
      evals.set(e.key, e)
      if (matchesName(e)) emit({ type: 'eval-end', at: Date.now(), result: e })
    },
    onTestRunEnd(modules, errors, reason) {
      if (collecting) return
      // Attempts finish in any order; results are listed by file, then as declared.
      const byFile = [...modules].sort((a, b) => (a.moduleId < b.moduleId ? -1 : 1))
      const finished = new Map(evals)
      evals.clear()
      for (const module of byFile) {
        for (const test of module.children.allTests()) {
          const e = toEngineEval(config.root, test, vitest)
          evals.set(e.key, finished.get(e.key) ?? e)
        }
      }
      const problems = moduleProblems(config.root, byFile)
      usage ??= problems.usage
      unhandledErrors = [
        ...unhandledErrors,
        ...problems.unhandled,
        ...errors.map((e) => e.message ?? String(e)),
      ]
      if (reason === 'interrupted') cancelled = true
    },
  }

  const warning = vitestMismatch(config.root)
  if (warning) process.stderr.write(`warning: ${warning}\n`)

  const stdout = new Capture()
  const stderr = new Capture()
  let vitest: Vitest | undefined
  let namePattern: RegExp | undefined
  const nameFilters: string[] = []
  const matchesName = (e: EngineEval) => !namePattern || namePattern.test(nameText(e))
  const signals = ['SIGINT', 'SIGTERM'] as const
  const ownListeners = new Set(signals.flatMap((signal) => process.listeners(signal)))
  const { concurrency } = options.run
  // Attempts wait on the network, not the CPU, so a few workers run many attempts each; one
  // worker per file in flight lets the scheduler balance across files.
  const workers = Math.max(1, Math.min(concurrency, availableParallelism()))
  let scheduler: SchedulerServer | undefined
  try {
    vitest = await createVitest(
      {
        config: false,
        root: config.root,
        include: config.include,
        // Recorded runs live next to the evals; never walk them looking for eval files.
        exclude: [
          ...configDefaults.exclude,
          '**/.es/**',
          `${relativeFile(config.root, config.history.dir)}/**`,
        ],
        watch: false,
        reporters: [reporter],
        setupFiles: [join(DIST_DIR, 'setup.js')],
        execArgv: ['--import', pathToFileURL(join(DIST_DIR, 'worker-signals.js')).href],
        testTimeout: config.timeoutMs,
        hookTimeout: config.timeoutMs,
        pool: 'forks',
        server: { deps: { external: [esDist] } },
        maxWorkers: workers,
        sequence: { concurrent: true },
        // Every attempt in a file asks the scheduler for a lease at once; it decides who runs.
        maxConcurrency: 10_000,
        retry: 0,
        allowOnly: !inCI(),
        passWithNoTests: true,
        onStackTrace: (_error, frame) =>
          !frame.file.includes('/node_modules/vitest/') &&
          !esDirs.some((dir) => frame.file.startsWith(dir)),
      },
      { customLogger: silentLogger, logLevel: 'silent', cacheDir: 'node_modules/.cache/es' },
      { stdout, stderr },
    )
    // Vitest's logger exits the process on SIGINT and SIGTERM; the CLI owns both instead.
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!ownListeners.has(listener)) process.off(signal, listener)
      }
    }
    vitest.provide('es:run', options.run)

    // A part that names an eval file picks files; any other part picks evals by name or cell.
    // Parts of one kind widen the selection, and the two kinds narrow each other.
    const pathFilters: string[] = []
    for (const f of options.filters) {
      if ((await vitest.globTestSpecifications([f])).length) pathFilters.push(f)
      else nameFilters.push(f)
    }
    const specs = await vitest.globTestSpecifications(pathFilters)
    if (nameFilters.length) {
      const escaped = nameFilters.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      namePattern = new RegExp(escaped.join('|'))
      vitest.setGlobalTestNamePattern(namePattern)
    }
    if (specs.length === 0)
      return { evals: [], unhandledErrors: [], cancelled: false, noFiles: true, stopped: false }

    if (options.onPlan) {
      collecting = true
      const collected = await vitest.collectTests(specs)
      collecting = false
      const plan = collectPlan(config.root, collected.testModules, matchesName, nameFilters)
      // When no part matched anything, the run's own "no evals matched" says so.
      if (plan.unmatched.length === options.filters.length) plan.unmatched = []
      if (!(await options.onPlan(plan))) {
        return { evals: [], unhandledErrors: [], cancelled: false, noFiles: false, stopped: true }
      }
    }

    scheduler = await startSchedulerServer({ gatherFiles: Math.min(specs.length, workers) })
    vitest.provide('es:scheduler', scheduler.address)

    const instance = vitest
    options.onCancellable?.(() => {
      cancelled = true
      mkdirSync(options.run.stagingDir, { recursive: true })
      writeFileSync(cancelMarker(options.run.stagingDir), '')
      void instance.cancelCurrentRun('keyboard-input')
    })
    await vitest.runTestSpecifications(specs, true)
  } catch (error) {
    if (error instanceof UsageError) throw error
    const detail = stderr.text.trim()
    throw new Error(`${(error as Error).message}${detail ? `\n${detail}` : ''}`)
  } finally {
    await vitest?.close()
    await scheduler?.close()
  }
  if (usage) throw new UsageError(usage)
  const matching = [...evals.values()].filter(matchesName)
  return { evals: matching, unhandledErrors, cancelled, noFiles: false, stopped: false }
}
