import { posix } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { execOptionsProblem } from '../contract/attempt.ts'
import { debugLog, debugTrace } from '../debug/attempt.ts'
import { acceptIntoSnapshot } from '../diff.ts'
import { SUBJECT } from '../engine/runtime.ts'
import { UsageError } from '../errors.ts'
import { redactSecrets, registerVariable } from '../redact.ts'
import type { Sandbox } from '../sandbox/index.ts'
import { clip, formatDuration } from '../text.ts'
import type { BackgroundHandle, ExecEnv, ExecResult, ExecRetry } from '../types.ts'
import type { Attempt } from './state.ts'

/** Runs a check or setup step with the checks' brokered secrets swapped in (see brokerPhases). */
export const asCheck = <T>(a: Attempt, fn: () => Promise<T>) =>
  a.phases ? a.phases.checks(fn) : fn()

/** The attempt's sandbox, started (with its session) by the first call that needs it. */
export const sandboxFor = async (a: Attempt, who: string): Promise<Sandbox> =>
  (await a.start(who))[0]

/**
 * `c.exec`'s own `env` as the sandbox gets it: each brokered secret's host value in it replaced
 * by that secret's placeholder, so the real value stays on the host and the gateway swaps it back
 * on the secret's hosts, as it does for the environment's variables.
 */
export function execEnv(a: Attempt, env: ExecEnv | undefined): Record<string, string> {
  if (!env) return {}
  const brokered = (a.env?.substitutions ?? [])
    .filter((s) => s.value.length >= 4)
    .toSorted((x, y) => y.value.length - x.value.length)
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    let v = value
    for (const s of brokered) v = v.replaceAll(s.value, s.placeholder)
    out[name] = v
  }
  return out
}

/**
 * `c.exec` runs with the checks' variables and secrets and its own `env` over them, each run
 * recorded and timed, and runs again on a non-zero exit while it has `retries` left; `c.readFile`
 * reads the sandbox as is; `c.writeFile` places a file the diff leaves out.
 */
export function createChecks(a: Attempt) {
  const execForeground = async (
    command: string,
    retries: number,
    interval: number,
    own: ExecEnv | undefined,
  ) => {
    const box = await sandboxFor(a, 'c.exec()')
    const env = { ...a.env?.checkVars, ...execEnv(a, own) }
    const start = performance.now()
    const tries: Array<ExecResult & { durationMs: number }> = []
    a.report({ kind: 'check-start', command })
    const r = await a.timed('checksMs', async () => {
      for (;;) {
        const began = performance.now()
        const r = await asCheck(a, () => box.exec(command, { signal: a.signal, env }))
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
      { command, ...(own ? { env: Object.keys(own) } : {}), ...r, durationMs, ...retried },
      `check output: ${clip(redactSecrets(command), 80)}`,
    )
    a.report({
      kind: 'check-end',
      command,
      exitCode: r.exitCode,
      ms: durationMs,
      ...(retries > 0 ? { try: tries.length, tries: retries + 1 } : {}),
    })
    // Names its command in `expect(await c.exec(…)).toSucceed()`'s default label.
    return Object.defineProperty(r, SUBJECT, { value: command })
  }
  type Options = ExecRetry & { env?: ExecEnv }
  function exec(command: string, options?: Options & { background?: false }): Promise<ExecResult>
  function exec(
    command: string,
    options: { background: true; env?: ExecEnv },
  ): Promise<BackgroundHandle>
  function exec(
    command: string,
    options?: Options & { background?: boolean },
  ): Promise<ExecResult | BackgroundHandle>
  function exec(
    command: string,
    options?: Options & { background?: boolean },
  ): Promise<ExecResult | BackgroundHandle> {
    // Before the options are checked, so a refusal that quotes a value masks a secret's.
    const env: unknown = options?.env
    if (env && typeof env === 'object') {
      for (const [name, value] of Object.entries(env)) {
        if (typeof value === 'string') registerVariable(name, value)
      }
    }
    const problem = options === undefined ? undefined : execOptionsProblem(options)
    if (problem) return Promise.reject(new UsageError(problem))
    if (options?.background) {
      return import('./capture.ts').then(({ startBackground }) =>
        startBackground(a, command, 'c.exec({ background: true })', execEnv(a, options.env)),
      )
    }
    const run = execForeground(
      command,
      options?.retries ?? 0,
      options?.interval ?? 1000,
      options?.env,
    )
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
