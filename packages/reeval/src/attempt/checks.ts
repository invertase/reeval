import { posix } from 'node:path'
import { debugLog, debugTrace } from '../debug/attempt.ts'
import { acceptIntoSnapshot } from '../diff.ts'
import { SUBJECT } from '../engine/runtime.ts'
import type { Sandbox } from '../sandbox/index.ts'
import { clip, formatDuration } from '../text.ts'
import type { BackgroundHandle, ExecResult } from '../types.ts'
import type { Attempt } from './state.ts'

/** Runs a check or setup step with the checks' brokered secrets swapped in (see brokerPhases). */
export const asCheck = <T>(a: Attempt, fn: () => Promise<T>) =>
  a.phases ? a.phases.checks(fn) : fn()

export function requireSandbox(a: Attempt, who = 'c.exec() or c.readFile()'): Sandbox {
  if (!a.sandbox) {
    throw new Error(`No sandbox yet: call c.send() or await c.sandbox() before ${who}`)
  }
  return a.sandbox
}

/**
 * `c.exec` runs with the checks' variables and secrets, each run recorded and
 * timed; `c.readFile` reads the sandbox as is; `c.writeFile` places a file the diff leaves out.
 */
export function createChecks(a: Attempt) {
  const checkEnv = () => (a.env?.checkVars ?? {}) as Record<string, string>
  const execForeground = async (command: string) => {
    const box = requireSandbox(a)
    const start = performance.now()
    a.report({ kind: 'check-start', command })
    const r = await a.timed('checksMs', () =>
      asCheck(a, () => box.exec(command, { signal: a.signal, env: checkEnv() })),
    )
    const durationMs = Math.round(performance.now() - start)
    a.record.checks.push({ command, ...r, durationMs })
    debugLog(
      'check',
      `$ ${clip(command, 160)} → exit ${r.exitCode} · ${formatDuration(durationMs)}`,
    )
    debugTrace(
      'check',
      'output',
      { command, ...r, durationMs },
      `check output: ${clip(command, 80)}`,
    )
    a.report({ kind: 'check-end', command, exitCode: r.exitCode, ms: durationMs })
    return r
  }
  function exec(command: string): Promise<ExecResult>
  function exec(command: string, options: { background: true }): Promise<BackgroundHandle>
  function exec(
    command: string,
    options?: { background?: boolean },
  ): Promise<ExecResult | BackgroundHandle>
  function exec(
    command: string,
    options?: { background?: boolean },
  ): Promise<ExecResult | BackgroundHandle> {
    if (options?.background) {
      return import('./capture.ts').then(({ startBackground }) => startBackground(a, command))
    }
    // Names its command in `expect(c.exec(…)).toSucceed()`'s default label.
    return Object.defineProperty(execForeground(command), SUBJECT, { value: command })
  }
  const readFile = (path: string) => requireSandbox(a).readFile(path)
  const writeFile = async (path: string, contents: string | Uint8Array) => {
    const box = requireSandbox(a, 'c.writeFile()')
    const home = path.startsWith('~/')
    const normal = posix.normalize((home ? path.slice(2) : path).replaceAll('\\', '/'))
    if (normal === '.' || /^([a-zA-Z]:)?\//.test(normal) || /^\.\.(\/|$)/.test(normal)) {
      throw new Error(
        `c.writeFile() takes a workspace-relative path or ~/…, not ${JSON.stringify(path)}`,
      )
    }
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
