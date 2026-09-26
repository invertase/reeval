import { debugLog, debugTrace } from '../debug/attempt.ts'
import type { Sandbox } from '../sandbox/index.ts'
import { clip, formatDuration } from '../text.ts'
import type { Attempt } from './state.ts'

/** Runs a check or setup step with the checks' brokered secrets swapped in (see brokerPhases). */
export const asCheck = <T>(a: Attempt, fn: () => Promise<T>) =>
  a.phases ? a.phases.checks(fn) : fn()

function requireSandbox(a: Attempt): Sandbox {
  if (!a.sandbox) {
    throw new Error(
      'No sandbox yet: call t.send() or await t.sandbox() before t.exec() or t.readFile()',
    )
  }
  return a.sandbox
}

/**
 * Phase 4, checks: `t.exec` runs with the checks' variables and secrets, each run recorded and
 * timed; `t.readFile` reads the sandbox as is.
 */
export function createChecks(a: Attempt) {
  const checkEnv = () => (a.env?.checkVars ?? {}) as Record<string, string>
  const exec = async (command: string) => {
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
  const readFile = (path: string) => requireSandbox(a).readFile(path)
  return { exec, readFile }
}
