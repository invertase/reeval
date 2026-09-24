// Main-process half of the engine adapter: embeds Vitest and translates its reporter events
// into ES types. Nothing here leaks Vitest types to callers.
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { configDefaults } from 'vitest/config'
import { createVitest, type Reporter, type TestCase, type Vitest } from 'vitest/node'
import { evalId, relativeFile } from '../ids.ts'
import type { EvalMeta, RunContext } from '../types.ts'
import type {} from './runtime.ts'

export type EngineEval = {
  id: string
  file: string
  /** Enclosing group names, outermost first. */
  group: string[]
  name: string
  state: 'passed' | 'failed' | 'skipped'
  durationMs: number
  errors: string[]
  meta: EvalMeta | undefined
}

export type EngineRun = {
  evals: EngineEval[]
  unhandledErrors: string[]
  cancelled: boolean
  noFiles: boolean
}

export type EngineOptions = {
  run: RunContext
  filters: string[]
  onEvalStart?: (e: Pick<EngineEval, 'id' | 'file' | 'name'>) => void
  onEvalResult?: (e: EngineEval) => void
  /** Called once the engine can be cancelled, with a function that cancels the run. */
  onCancellable?: (cancel: () => void) => void
}

const require = createRequire(import.meta.url)
export const vitestVersion: string = require('vitest/package.json').version

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

function toEngineEval(root: string, test: TestCase): EngineEval {
  const file = relativeFile(root, test.module.moduleId)
  const group = groupPath(test)
  const result = test.result()
  const state =
    result.state === 'failed' ? 'failed' : result.state === 'passed' ? 'passed' : 'skipped'
  return {
    id: evalId(file, [...group, test.name]),
    file,
    group,
    name: test.name,
    state,
    durationMs: Math.round(test.diagnostic()?.duration ?? 0),
    errors: (result.errors ?? []).map((e) => cleanMessage(e.message ?? String(e))),
    meta: test.meta().es,
  }
}

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

  const reporter: Reporter = {
    onTestCaseReady(test) {
      const file = relativeFile(config.root, test.module.moduleId)
      const id = evalId(file, [...groupPath(test), test.name])
      options.onEvalStart?.({ id, file, name: test.name })
    },
    onTestCaseResult(test) {
      const e = toEngineEval(config.root, test)
      evals.set(e.id, e)
      if (matchesName(e)) options.onEvalResult?.(e)
    },
    onTestRunEnd(modules, errors, reason) {
      for (const module of modules) {
        for (const test of module.children.allTests()) {
          const e = toEngineEval(config.root, test)
          if (!evals.has(e.id)) evals.set(e.id, e)
        }
        for (const error of module.errors()) unhandledErrors.push(error.message)
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
    !namePattern || namePattern.test([...e.group, e.name].join(' '))
  const sigintListeners = new Set(process.listeners('SIGINT'))
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
        maxWorkers: 1,
        retry: 0,
        allowOnly: !process.env.CI,
        passWithNoTests: true,
        attachmentsDir: '.es/attachments',
        onStackTrace: (_error, frame) => !frame.file.includes('/node_modules/vitest/'),
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
  }
  const matching = [...evals.values()].filter(matchesName)
  return { evals: matching, unhandledErrors, cancelled, noFiles: false }
}
