import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { debugLog } from '../debug/attempt.ts'
import { allowedHosts, isDirect } from '../egress.ts'
import type { RawAssertion } from '../engine/runtime.ts'
import { isTimeout } from '../errors.ts'
import { expectedBlockedFor } from '../harness/agents.ts'
import { attemptKey, recordFileName } from '../ids.ts'
import { sandboxProvider } from '../options.ts'
import { redactJson, redactSecrets, redactSplitSecrets } from '../redact.ts'
import { InfraError, type Sandbox } from '../sandbox/index.ts'
import { PrepareError } from '../sandbox/provider.ts'
import { capMiddle, clip } from '../text.ts'
import type { ErrorKind, EvalMeta, EvalRecord, TranscriptEvent } from '../types.ts'
import { checkFailure } from './assertions.ts'
import { writeCaptureSidecars } from './capture.ts'
import type { Attempt } from './state.ts'

function classify(error: unknown, signal: AbortSignal): { kind: ErrorKind; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  if (signal.aborted) {
    return isTimeout(signal.reason)
      ? { kind: 'timeout', message: 'The eval timed out' }
      : { kind: 'aborted', message: 'The run was canceled' }
  }
  if (error instanceof InfraError) return { kind: 'infra', message }
  return { kind: 'assertion', message }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const judged = (r: RawAssertion) => /(^|\.)toPass$/.test(r.matcher)

/**
 * Whether `error` is a judge's: one a judge threw, or what a `toPass()` or `.not.toPass()` call
 * failed with. A failing verdict the eval didn't assert, or asserted with `.not.toPass()`, isn't.
 * By message too, since another language's runner hands back its own copy of the error.
 */
function isJudges(a: Attempt, error: unknown, raw: readonly RawAssertion[]): boolean {
  const message = messageOf(error)
  if (a.judgeThrown.has(message)) return true
  return raw.some(
    (r) =>
      r.status !== 'pass' && judged(r) && (r.error === error || messageOf(r.error) === message),
  )
}

/**
 * The error that fails the attempt: a judge's gives way to the first other check that didn't hold
 * (an `expect.soft`, or a hard check the eval caught), whichever came first, so the attempt fails
 * as that check.
 */
export function attemptError(a: Attempt, error: unknown, raw: readonly RawAssertion[]): unknown {
  if (!isJudges(a, error, raw)) return error
  const check = raw.find((r) => r.status !== 'pass' && !judged(r))
  return check ? checkFailure([check]) : error
}

/**
 * Why the attempt failed, into the record: the eval's own timeout, a cancel, an infra error, or an
 * assertion, which is the judge's when `error`, from `attemptError`, is a judge's.
 */
export function recordFailure(
  a: Attempt,
  error: unknown,
  timedOut: boolean,
  raw: readonly RawAssertion[],
): void {
  const { record } = a
  record.error = timedOut
    ? { kind: 'timeout', message: 'The eval timed out' }
    : classify(error, a.signal)
  record.error.message = capMiddle(redactSecrets(record.error.message))
  if (error instanceof PrepareError && !timedOut) {
    const { class: kind, stage, ref, cause, log, setBy } = error.failure
    record.error.prepare = { class: kind, stage, ref, cause, log, setBy: setBy ?? [] }
  }
  if (record.error.kind === 'assertion' && isJudges(a, error, raw)) {
    record.error.kind = 'judge'
  }
  record.outcome = record.error.kind === 'infra' ? 'infra_error' : 'fail'
}

/**
 * A process the kernel killed at the sandbox's memory limit makes the attempt an infra error,
 * whatever its checks said: the limit, not the agent, decided it. Returns the error to fail it with.
 */
export async function recordOom(
  a: Attempt,
  sandbox: Sandbox | undefined,
): Promise<InfraError | undefined> {
  const oom = await sandbox?.oomKills?.().catch(() => null)
  const at = oom && `the ${oom.limit} limit${oom.swap ? ` (+${oom.swap} swap)` : ''}`
  if (oom) debugLog('teardown', `oom_kill ${oom.kills} at ${at}`)
  if (!oom?.kills) return undefined
  const processes = oom.kills === 1 ? '1 process' : `${oom.kills} processes`
  const message = `out of memory: ${processes} killed at ${at}; raise ${sandboxProvider(a.spec.sandbox)}({ memory })`
  a.record.error = { kind: 'infra', message, resource: { cause: 'oom', kills: oom.kills } }
  a.record.outcome = 'infra_error'
  return new InfraError(message)
}

/**
 * The attempt's egress policy and, when its sandbox records it, what it contacted and was refused.
 * Refused hosts the harness always tries (in a session like this one) are `expectedBlocked`,
 * summarized in one `-v` line.
 */
export function recordEgress(a: Attempt, sandbox: Sandbox | undefined): void {
  const traffic = sandbox?.traffic?.()
  const expected = expectedBlockedFor(
    a.spec.harness,
    (a.env?.plugins.length ?? 0) > 0,
    a.spec.vertex,
  )
  const refused = traffic?.blocked ?? []
  const isExpected = (h: { host: string }) => !!expected?.hosts.includes(h.host)
  const expectedBlocked = refused.filter(isExpected)
  a.record.egress = {
    policy: a.spec.egress.policy,
    allowed: allowedHosts(a.spec.egress),
    recorded: !!traffic,
    ...(traffic && isDirect(a.spec.egress.policy) ? { partial: true as const } : {}),
    contacted: traffic?.contacted ?? [],
    blocked: refused.filter((h) => !isExpected(h)),
    expectedBlocked,
  }
  if (expected && expectedBlocked.length) {
    const hosts = expectedBlocked.map((h) => `${h.host}:${h.port} ×${h.connections}`).join(', ')
    debugLog('gateway', `expected blocks, not logged per request: ${hosts} · ${expected.why}`)
  }
  a.record.servedModels = sandbox?.servedModels?.() ?? null
  const asked = sandbox?.askedModels?.() ?? []
  if (asked.length) a.record.askedModels = asked
  const upstreams = sandbox?.upstreams?.() ?? []
  if (upstreams.length) a.record.upstreams = upstreams
  const cost = sandbox?.reportedCostUsd?.()
  if (cost !== undefined) a.record.reportedCostUsd = cost
}

/**
 * The record as its staging file holds it: redacted, with a secret split across a turn's raw
 * stream parts masked first, since masking each part on its own leaves pieces of it to rebuild.
 */
export function stagedRecordJson(record: EvalRecord): string {
  const turns = record.turns.map((turn) =>
    turn.raw
      ? {
          ...turn,
          raw: redactSplitSecrets(turn.raw.map((part) => JSON.stringify(part))).map(
            (line) => JSON.parse(line) as unknown,
          ),
        }
      : turn,
  )
  return redactJson({ ...record, turns }, 2)
}

/** Writes the attempt's record, redacted, and returns what the runner reports. */
export async function writeRecord(a: Attempt, stagingDir: string, id: string): Promise<EvalMeta> {
  const { record, spec } = a
  const recordPath = join(
    stagingDir,
    'evals',
    recordFileName(attemptKey(id, spec.cell.key, spec.n)),
  )
  await mkdir(join(stagingDir, 'evals'), { recursive: true })
  await writeCaptureSidecars(
    stagingDir,
    recordFileName(attemptKey(id, spec.cell.key, spec.n)),
    a.artifactBlobs,
  )
  // Replaced whole: reeval studio reads it while the run goes on.
  const tmp = `${recordPath}.${process.pid}.tmp`
  await writeFile(tmp, stagedRecordJson(record))
  await rename(tmp, recordPath)
  return {
    outcome: record.outcome,
    errorKind: record.error?.kind ?? null,
    judgements: record.judgements.map((j) => ({
      verdict: j.verdict,
      score: j.score,
      threshold: j.threshold,
      question: clip(j.question, 200),
    })),
    turnErrors: turnErrors(record.turns.map((t) => t.transcript)),
    ...(record.error?.prepare
      ? { prepare: { ref: record.error.prepare.ref, stage: record.error.prepare.stage } }
      : {}),
  }
}

/** `turn N error: <message>` for each turn with an error event. */
export function turnErrors(transcripts: TranscriptEvent[][]): string[] {
  return transcripts.flatMap((events, i) => {
    const found = events.find((e) => e.type === 'error')
    return found?.type === 'error'
      ? [`turn ${i + 1} error: ${clip(redactSecrets(found.message.trim()), 500)}`]
      : []
  })
}
