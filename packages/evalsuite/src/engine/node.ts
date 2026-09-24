// Main-process half of the engine adapter: embeds Vitest and translates its reporter events
// into ES types. Nothing here leaks Vitest types to callers.
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { configDefaults } from 'vitest/config'
import { createVitest, type Reporter, type TestCase, type Vitest } from 'vitest/node'
import { inCI } from '../env.ts'
import { UsageError } from '../errors.ts'
import { attemptKey, evalId, relativeFile } from '../ids.ts'
import { type SchedulerServer, startSchedulerServer } from '../scheduler/server.ts'
import type { RunContext } from '../types.ts'
import type { EsEvent, EvalResult } from '../ui/events.ts'
import type {} from './runtime.ts'

/** One attempt: a Vitest test. */
export type EngineEval = EvalResult

export type EngineRun = {
  evals: EngineEval[]
  unhandledErrors: string[]
  cancelled: boolean
  noFiles: boolean
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
}

const require = createRequire(import.meta.url)
export const vitestVersion: string = require('vitest/package.json').version
export const engineVersions = { vitest: vitestVersion }

// ES's own frames (src/ via source maps, or dist/) are noise in an eval's stack trace.
const esDirs = ['../../src/', '../../dist/'].map((p) => fileURLToPath(new URL(p, import.meta.url)))

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

/** Fails fast if two copies of Vitest would be loaded, which breaks test registration. */
function assertSingleVitest(root: string): string | undefined {
  try {
    const theirs = createRequire(`${root}/`).resolve('vitest/package.json')
    const ours = require.resolve('vitest/package.json')
    if (realpathSync(theirs) !== realpathSync(ours)) {
      return `Your project resolves its own copy of vitest (${theirs}). ES bundles vitest ${vitestVersion}; evals must import from 'evalsuite' only.`
    }
  } catch {}
  return undefined
}

export async function runEngine(options: EngineOptions): Promise<EngineRun> {
  const { config } = options.run
  const evals = new Map<string, EngineEval>()
  let unhandledErrors: string[] = []
  let cancelled = false
  let usage: string | undefined

  const emit = options.onEvent ?? (() => {})
  const keysByTask = new Map<string, string>()
  const skipped = (test: TestCase) => test.options.mode === 'skip' || test.options.mode === 'todo'
  const reporter: Reporter = {
    onTestRunStart(specifications) {
      options.onRunStart?.(specifications.length)
    },
    onTestModuleCollected(module) {
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
      const e = toEngineEval(config.root, test, vitest)
      evals.set(e.key, e)
      if (matchesName(e)) emit({ type: 'eval-end', at: Date.now(), result: e })
    },
    onTestRunEnd(modules, errors, reason) {
      // Attempts finish in any order; results are listed by file, then as declared.
      const byFile = [...modules].sort((a, b) => (a.moduleId < b.moduleId ? -1 : 1))
      const finished = new Map(evals)
      evals.clear()
      for (const module of byFile) {
        for (const test of module.children.allTests()) {
          const e = toEngineEval(config.root, test, vitest)
          evals.set(e.key, finished.get(e.key) ?? e)
          if (e.errors.some((m) => ONLY_IN_CI.test(m))) usage = onlyInCi(e.file)
        }
        for (const error of module.errors()) {
          const file = relativeFile(config.root, module.moduleId)
          if (error.name === 'OnlyInCiError' || ONLY_IN_CI.test(error.message)) {
            usage = onlyInCi(file)
          } else if (error.name === 'UsageError' || error.name === 'DefinitionError') {
            usage = `${file}: ${error.message}`
          } else unhandledErrors.push(error.message)
        }
      }
      unhandledErrors = [...unhandledErrors, ...errors.map((e) => e.message ?? String(e))]
      if (reason === 'interrupted') cancelled = true
    },
  }

  const warning = assertSingleVitest(config.root)
  if (warning) process.stderr.write(`warning: ${warning}\n`)

  const stdout = new Capture()
  const stderr = new Capture()
  let vitest: Vitest | undefined
  let namePattern: RegExp | undefined
  const matchesName = (e: EngineEval) =>
    !namePattern ||
    namePattern.test(
      [...e.group, e.name, e.attempt ? `[${e.attempt.cell.key}#${e.attempt.n}]` : ''].join(' '),
    )
  const sigintListeners = new Set(process.listeners('SIGINT'))
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
        setupFiles: [fileURLToPath(new URL('../setup.js', import.meta.url))],
        testTimeout: config.timeoutMs,
        hookTimeout: config.timeoutMs,
        pool: 'forks',
        maxWorkers: workers,
        sequence: { concurrent: true },
        // Every attempt in a file asks the scheduler for a lease at once; it decides who runs.
        maxConcurrency: 10_000,
        retry: 0,
        allowOnly: !inCI(),
        passWithNoTests: true,
        attachmentsDir: '.es/attachments',
        onStackTrace: (_error, frame) =>
          !frame.file.includes('/node_modules/vitest/') &&
          !esDirs.some((dir) => frame.file.startsWith(dir)),
      },
      { customLogger: silentLogger, logLevel: 'silent', cacheDir: 'node_modules/.cache/es' },
      { stdout, stderr },
    )
    // Vitest's logger exits the process on SIGINT; the CLI owns Ctrl-C instead.
    for (const listener of process.listeners('SIGINT')) {
      if (!sigintListeners.has(listener)) process.off('SIGINT', listener)
    }
    vitest.provide('es:run', options.run)

    let specs = await vitest.globTestSpecifications(options.filters)
    if (specs.length === 0 && options.filters.length > 0) {
      const escaped = options.filters.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      namePattern = new RegExp(escaped.join('|'))
      vitest.setGlobalTestNamePattern(namePattern)
      specs = await vitest.globTestSpecifications()
    }
    if (specs.length === 0)
      return { evals: [], unhandledErrors: [], cancelled: false, noFiles: true }

    scheduler = await startSchedulerServer({ gatherFiles: Math.min(specs.length, workers) })
    vitest.provide('es:scheduler', scheduler.address)

    const instance = vitest
    options.onCancellable?.(() => {
      cancelled = true
      void instance.cancelCurrentRun('keyboard-input')
    })
    await vitest.runTestSpecifications(specs, true)
  } catch (error) {
    const detail = stderr.text.trim()
    throw new Error(`${(error as Error).message}${detail ? `\n${detail}` : ''}`)
  } finally {
    await vitest?.close()
    await scheduler?.close()
  }
  if (usage) throw new UsageError(usage)
  const matching = [...evals.values()].filter(matchesName)
  return { evals: matching, unhandledErrors, cancelled, noFiles: false }
}
