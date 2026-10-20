// reeval's side of the sandbox prepare contract (provider.ts), the same for every provider: check
// each provider once, prepare every distinct environment the plan needs in parallel before any
// attempt starts, retry transient failures, and cache each result for the run, failures too.
// Attempts, in the engine's workers, only read the results (`preparedFor`).
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RETRY_DELAYS } from '@reeval/sandbox-docker'
import { levelOf, sandboxProvider } from '../options.ts'
import type { HarnessDescriptor, SandboxDescriptor } from '../types.ts'
import {
  type PreparedHandle,
  PrepareError,
  type PrepareFailure,
  type SandboxProvider,
} from './provider.ts'

/** One attempt's need: its sandbox and harness, and the levels that set each. */
export type PrepareUse = {
  harness: HarnessDescriptor
  sandbox: SandboxDescriptor
  /** `reeval.config.ts`, `profiles.pr.defaults`, `group("net")` or `evaluate("x")`. */
  setBy: { sandbox: string; harness: string }
}

/** One distinct environment to prepare, with every level that asked for it. */
export type PrepareTarget = {
  /** The provider: the sandbox's kind, or `podman` for a Docker sandbox on Podman. */
  kind: string
  key: string
  /** How the terminal names it, e.g. `docker:python`. */
  label: string
  sandbox: SandboxDescriptor
  harness: HarnessDescriptor
  /** The levels that set the sandbox, in first-use order. */
  setBy: string[]
  /** Set by the config or a profile, sandbox and harness both: a failure stops the run. */
  runWide: boolean
}

export type PrepareOutcome =
  | { target: PrepareTarget; ok: true; handle: PreparedHandle; ms: number }
  | { target: PrepareTarget; ok: false; failure: PrepareFailure; ms: number }

export type PrepareEvent =
  | { state: 'start'; targets: PrepareTarget[] }
  | { state: 'ready' | 'failed'; outcome: PrepareOutcome }

/** How many environments are prepared at once. */
export const PREPARE_LIMIT = 3

const runWideLevel = (where: string) => {
  const level = levelOf(where)
  return level === 'config' || level === 'profile'
}

/** The distinct environments `uses` need, keyed by each provider. */
export function prepareTargets(
  uses: PrepareUse[],
  providers: Record<string, SandboxProvider>,
  label: (use: PrepareUse) => string,
): PrepareTarget[] {
  const targets = new Map<string, PrepareTarget>()
  for (const use of uses) {
    const kind = sandboxProvider(use.sandbox)
    const provider = providers[kind]
    if (!provider) continue
    const key = `${kind}\0${provider.key(use.sandbox, use.harness)}`
    const target = targets.get(key) ?? {
      kind,
      key: provider.key(use.sandbox, use.harness),
      label: label(use),
      sandbox: use.sandbox,
      harness: use.harness,
      setBy: [],
      runWide: false,
    }
    if (!target.setBy.includes(use.setBy.sandbox)) target.setBy.push(use.setBy.sandbox)
    target.runWide ||= runWideLevel(use.setBy.sandbox) && runWideLevel(use.setBy.harness)
    targets.set(key, target)
  }
  return [...targets.values()]
}

/** A config-level environment that can't be prepared: the run stops before any attempt. */
export class RunStopError extends Error {
  override name = 'RunStopError'
  readonly outcome: Extract<PrepareOutcome, { ok: false }>
  constructor(outcome: Extract<PrepareOutcome, { ok: false }>) {
    super(
      `${outcome.failure.message}\nThe sandbox ${outcome.target.label} is set by ${outcome.target.setBy.join(', ')} for every eval, so nothing ran.`,
    )
    this.outcome = outcome
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })

/** Errors already retried as far as the policy allows, maybe by another target's step. */
const retried = new WeakSet<object>()

const failureOf = (provider: SandboxProvider, error: unknown): PrepareFailure =>
  error instanceof PrepareError ? error.failure : provider.classify(error)

/**
 * Checks each provider, then prepares every target, `limit` at a time. A failed check stops
 * everything (a {@link PrepareError}); so does a failed `runWide` target (a
 * {@link RunStopError}), which also cancels the rest. Any other failure is its target's alone.
 */
export async function prepareAll(
  targets: PrepareTarget[],
  options: {
    providers: Record<string, SandboxProvider>
    root: string
    signal?: AbortSignal
    limit?: number
    /** Waits before each retry of a transient failure; its length bounds the retries. */
    delays?: number[]
    log?: (line: string) => void
    onEvent?: (e: PrepareEvent) => void
  },
): Promise<PrepareOutcome[]> {
  const { providers, root } = options
  const delays = options.delays ?? RETRY_DELAYS
  const stop = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal
  for (const kind of new Set(targets.map((t) => t.kind))) {
    const provider = providers[kind] as SandboxProvider
    try {
      await provider.check()
    } catch (error) {
      throw error instanceof PrepareError ? error : new PrepareError(provider.classify(error))
    }
  }
  if (targets.length) options.onEvent?.({ state: 'start', targets })

  const one = async (target: PrepareTarget): Promise<PrepareOutcome> => {
    const provider = providers[target.kind] as SandboxProvider
    const retry = async <T>(step: () => Promise<T>): Promise<T> => {
      for (let i = 0; ; i++) {
        try {
          return await step()
        } catch (error) {
          const done = error instanceof Object && retried.has(error)
          const transient = !done && failureOf(provider, error).class === 'transient'
          if (!transient || i >= delays.length || signal.aborted) {
            if (error instanceof Object) retried.add(error)
            throw error
          }
          options.log?.(
            `retrying ${target.label}: ${String((error as Error).message).split('\n')[0]}`,
          )
          await sleep(delays[i] ?? 0, signal)
        }
      }
    }
    const start = performance.now()
    try {
      const ctx = { root, signal, log: options.log ?? (() => {}), retry }
      // A provider that doesn't retry its own steps is retried as a whole.
      const handle = await retry(() => provider.prepare(target.sandbox, target.harness, ctx))
      return { target, ok: true, handle, ms: performance.now() - start }
    } catch (error) {
      const failure = failureOf(provider, error)
      return { target, ok: false, failure, ms: performance.now() - start }
    }
  }

  const outcomes: PrepareOutcome[] = []
  let stopped: Extract<PrepareOutcome, { ok: false }> | null = null
  let next = 0
  const worker = async () => {
    while (next < targets.length && !signal.aborted) {
      const target = targets[next++] as PrepareTarget
      const outcome = await one(target)
      if (stopped) return
      outcomes.push(outcome)
      if (!outcome.ok && target.runWide && !options.signal?.aborted) {
        stopped = outcome
        stop.abort()
        return
      }
      options.onEvent?.({ state: outcome.ok ? 'ready' : 'failed', outcome })
    }
  }
  const limit = Math.max(1, options.limit ?? PREPARE_LIMIT)
  await Promise.all(Array.from({ length: Math.min(limit, targets.length) }, worker))
  if (stopped) throw new RunStopError(stopped)
  options.signal?.throwIfAborted()
  return targets.flatMap((t) => outcomes.filter((o) => o.target === t))
}

type Entry =
  | { handle: PreparedHandle }
  | { failure: PrepareFailure; label: string; setBy: string[] }

const preparedDir = (root: string) => join(root, '.reeval', 'cache', 'prepared')
const preparedFile = (root: string, runId: string) => join(preparedDir(root), `${runId}.json`)

/** Writes what the attempts start from, by provider and key, for the run's workers. */
export function writePrepared(root: string, runId: string, outcomes: PrepareOutcome[]): void {
  const doc: Record<string, Record<string, Entry>> = {}
  for (const o of outcomes) {
    const kind = doc[o.target.kind] ?? {}
    doc[o.target.kind] = kind
    kind[o.target.key] = o.ok
      ? { handle: o.handle }
      : { failure: o.failure, label: o.target.label, setBy: o.target.setBy }
  }
  mkdirSync(preparedDir(root), { recursive: true })
  writeFileSync(preparedFile(root, runId), JSON.stringify(doc))
  // A run that crashed leaves its file; a day later nothing reads it.
  for (const name of readdirSync(preparedDir(root))) {
    const path = join(preparedDir(root), name)
    if (Date.now() - statSync(path).mtimeMs > 86_400_000) rmSync(path, { force: true })
  }
}

export const removePrepared = (root: string, runId: string) =>
  rmSync(preparedFile(root, runId), { force: true })

const read = new Map<string, Record<string, Record<string, Entry>> | null>()

/**
 * What an attempt starts from, as preflight prepared it: the handle, or the prepare failure its
 * cells share, thrown as a {@link PrepareError}. Null when preflight didn't prepare this run.
 */
export function preparedFor(
  root: string,
  runId: string,
  provider: SandboxProvider,
  sandbox: SandboxDescriptor,
  harness: HarnessDescriptor,
): PreparedHandle | undefined {
  const file = preparedFile(root, runId)
  if (!read.has(file)) {
    let doc: Record<string, Record<string, Entry>> | null = null
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'))
    } catch {}
    read.set(file, doc)
  }
  const entry = read.get(file)?.[sandboxProvider(sandbox)]?.[provider.key(sandbox, harness)]
  if (!entry) return undefined
  if ('failure' in entry) {
    throw new PrepareError({
      ...entry.failure,
      setBy: entry.setBy,
      message: `${entry.failure.message}\n(the sandbox ${entry.label}, set by ${entry.setBy.join(', ')}, failed to prepare before the run started; every attempt that needs it fails with this)`,
    })
  }
  return entry.handle
}
