import { posix } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { execOptionsProblem } from '../contract/attempt.ts'
import { debugLog, debugTrace } from '../debug/attempt.ts'
import { acceptIntoSnapshot } from '../diff.ts'
import { SUBJECT } from '../engine/runtime.ts'
import { UsageError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import type { Sandbox } from '../sandbox/index.ts'
import { clip, formatDuration } from '../text.ts'
import type { BackgroundHandle, ExecResult, ExecRetry } from '../types.ts'
import type { Attempt } from './state.ts'

/** Runs a check or setup step with the checks' brokered secrets swapped in (see brokerPhases). */
export const asCheck = <T>(a: Attempt, fn: () => Promise<T>) =>
  a.phases ? a.phases.checks(fn) : fn()

/** The attempt's sandbox, started (with its session) by the first call that needs it. */
export const sandboxFor = async (a: Attempt, who: string): Promise<Sandbox> =>
  (await a.start(who))[0]

/**
 * `c.exec` runs with the checks' variables and secrets, each run recorded and timed, and runs
 * again on a non-zero exit while it has `retries` left; `c.readFile` reads the sandbox as is;
 * `c.writeFile` places a file the diff leaves out.
 */
export function createChecks(a: Attempt) {
  const checkEnv = () => (a.env?.checkVars ?? {}) as Record<string, string>
  const execForeground = async (command: string, retries: number, interval: number) => {
    const box = await sandboxFor(a, 'c.exec()')
    const start = performance.now()
    const tries: Array<ExecResult & { durationMs: number }> = []
    a.report({ kind: 'check-start', command })
    const r = await a.timed('checksMs', async () => {
      for (;;) {
        const began = performance.now()
        const r = await asCheck(a, () => box.exec(command, { signal: a.signal, env: checkEnv() }))
        tries.push({ ...r, durationMs: Math.round(performance.now() - began) })
        if (r.exitCode === 0 || tries.length > retries) return r
        debugLog(
          'check',
          `$ ${clip(redactSecrets(command), 160)} → exit ${r.exitCode} on try ${tries.length} of ${retries + 1}, again in ${formatDuration(interval)}`,
        )
        await sleep(interval, undefined, { signal: a.signal })
      }
    })
    const durationMs = Math.round(performance.now() - start)
    const retried = retries > 0 ? { retries, tries } : {}
    a.record.checks.push({ command, ...r, durationMs, ...retried })
    const of = retries > 0 ? ` on try ${tries.length} of ${retries + 1}` : ''
    debugLog(
      'check',
      `$ ${clip(redactSecrets(command), 160)} → exit ${r.exitCode}${of} · ${formatDuration(durationMs)}`,
    )
    debugTrace(
      'check',
      'output',
      { command, ...r, durationMs, ...retried },
      `check output: ${clip(redactSecrets(command), 80)}`,
    )
    a.report({
      kind: 'check-end',
      command,
      exitCode: r.exitCode,
      ms: durationMs,
      ...(retries > 0 ? { try: tries.length, tries: retries + 1 } : {}),
    })
    return r
  }
  function exec(command: string, options?: ExecRetry & { background?: false }): Promise<ExecResult>
  function exec(command: string, options: { background: true }): Promise<BackgroundHandle>
  function exec(
    command: string,
    options?: ExecRetry & { background?: boolean },
  ): Promise<ExecResult | BackgroundHandle>
  function exec(
    command: string,
    options?: ExecRetry & { background?: boolean },
  ): Promise<ExecResult | BackgroundHandle> {
    const problem = options === undefined ? undefined : execOptionsProblem(options)
    if (problem) return Promise.reject(new UsageError(problem))
    if (options?.background) {
      return import('./capture.ts').then(({ startBackground }) =>
        startBackground(a, command, 'c.exec({ background: true })'),
      )
    }
    const run = execForeground(command, options?.retries ?? 0, options?.interval ?? 1000)
    // Names its command in `expect(c.exec(…)).toSucceed()`'s default label.
    return Object.defineProperty(run, SUBJECT, { value: command })
  }
  const readFile = async (path: string) => (await sandboxFor(a, 'c.readFile()')).readFile(path)
  const writeFile = async (path: string, contents: string | Uint8Array) => {
    const home = path.startsWith('~/')
    const normal = posix.normalize((home ? path.slice(2) : path).replaceAll('\\', '/'))
    if (normal === '.' || /^([a-zA-Z]:)?\//.test(normal) || /^\.\.(\/|$)/.test(normal)) {
      throw new Error(
        `c.writeFile() takes a workspace-relative path or ~/…, not ${JSON.stringify(path)}`,
      )
    }
    const box = await sandboxFor(a, 'c.writeFile()')
    a.signal.throwIfAborted()
    await box.writeFile(home ? `~/${normal}` : normal, contents)
    if (!home) await acceptIntoSnapshot(box, normal, a.signal)
    const bytes = typeof contents === 'string' ? Buffer.byteLength(contents) : contents.byteLength
    debugLog(
      'check',
      `wrote ${path} (${bytes} bytes)${home ? '' : ', kept out of the diff until something changes it'}`,
    )
  }
  return { exec, readFile, writeFile }
}
