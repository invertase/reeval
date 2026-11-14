import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentError } from '@reeval/agents'
import { debugLog } from '../debug/attempt.ts'
import { allowedHosts, isDirect } from '../egress.ts'
import type { RawAssertion } from '../engine/runtime.ts'
import { isTimeout } from '../errors.ts'
import { expectedBlockedFor } from '../harness/agents.ts'
import { ProviderStopError } from '../harness/provider-stop.ts'
import { attemptKey, recordFileName } from '../ids.ts'
import { modelCallEvents } from '../model-calls.ts'
import { sandboxProvider } from '../options.ts'
import { redactJson, redactSecrets, redactSplitSecrets } from '../redact.ts'
import { InfraError, RunStopped, type Sandbox } from '../sandbox/index.ts'
import { PrepareError } from '../sandbox/provider.ts'
import { capMiddle, clip } from '../text.ts'
import type { ErrorKind, EvalMeta, EvalRecord, TranscriptEvent } from '../types.ts'
import { resourcesLine } from '../view/resources.ts'
import { messageLine } from '../view/suite.ts'
import { inferDurations, sumSplits, timeSplit } from '../view/timeline.ts'
import { turnErrorKind } from '../view/turn-error.ts'
import { checkFailure } from './assertions.ts'
import { writeCaptureSidecars } from './capture.ts'
import type { Attempt } from './state.ts'

/**
 * An unhandled mid-turn `status === 'error'` (body never read `turn.status`) becomes an
 * infra error so crashed attempts leave the counted pass/fail denominator.
 */
export function reclassifyTurnErrors(a: Attempt): void {
  const { record } = a
  if (record.outcome !== 'pass' && record.outcome !== 'fail') return
  const index = record.turns.findIndex((t) => t.status === 'error')
  if (index < 0) return
  // Persist whether the body inspected status, so older-record viewers can tell.
  if (a.turnStatusRead) {
    record.turnStatusRead = true
    return
  }
  record.turnStatusRead = false
  const turn = record.turns[index]
  if (!turn) return
  const errEvent = turn.transcript.find((e) => e.type === 'error')
  const errText = errEvent && errEvent.type === 'error' ? errEvent.message : undefined
  const kind = turnErrorKind(errText)
  const detail = messageLine(errText ?? 'unknown error')
  record.outcome = 'infra_error'
  record.error = {
    kind: 'infra',
    message: `Turn ${index} ended with an error: ${detail}`,
    turn: { index, kind },
  }
}

function classify(error: unknown, signal: AbortSignal): { kind: ErrorKind; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  if (signal.aborted) {
    return isTimeout(signal.reason)
      ? { kind: 'timeout', message: 'The eval timed out' }
      : { kind: 'aborted', message: 'The run was canceled' }
  }
  if (error instanceof RunStopped) return { kind: 'aborted', message }
  if (error instanceof AgentError) return { kind: 'infra', message }
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

/** The error the attempt's failed judge calls fail it with once its body is done, if any failed. */
export function judgeErrorsMessage(a: Attempt): string | undefined {
  const messages = a.judgeErrors.toSorted((x, y) => x.call - y.call).map((e) => e.message)
  const [only, ...more] = messages
  if (!only) return undefined
  return more.length ? `${more.length + 1} judge calls failed:\n${messages.join('\n')}` : only
}

/** A matcher's message without the `label: ` its `expect` puts first. */
const unlabeled = (r: RawAssertion) => {
  const message = messageOf(r.error)
  const prefix = r.label === undefined ? '' : `${r.label}: `
  return message.startsWith(prefix) ? message.slice(prefix.length) : message
}

/**
 * Whether judge calls the provider couldn't answer (a rate limit, a 5xx, overload, the network,
 * after the retries) are all that failed the attempt: every failed call was transient, and every
 * check that didn't hold is a `toPass()` on one of them, not polled. A verdict that answered, a
 * non-transient judge error (a bad key or model, an input over the provider's limit) or any other
 * check makes it the attempt's own failure. By message, since another language's runner hands back
 * its own copy of the error.
 */
function judgeOutage(a: Attempt, error: unknown, raw: readonly RawAssertion[]): boolean {
  if (!a.judgeErrors.length || !a.judgeErrors.every((e) => e.transient)) return false
  // A judge that threw (no model) is the eval's own mistake.
  const message = messageOf(error)
  if (a.judgeThrown.has(message) && message !== judgeErrorsMessage(a)) return false
  const unanswered = new Set(a.judgeErrors.map((e) => e.matcher))
  // A poll's tries the judge answered "no" to were retried away, so its last outage hides them.
  return raw.every(
    (r) =>
      r.status === 'pass' ||
      (judged(r) && !r.matcher.startsWith('poll.') && unanswered.has(unlabeled(r))),
  )
}

/**
 * The error that fails the attempt: a judge's gives way to the first other check that didn't hold
 * (an `expect`, or an `expect.require` the eval caught), whichever came first, so the attempt
 * fails as that check.
 */
export function attemptError(a: Attempt, error: unknown, raw: readonly RawAssertion[]): unknown {
  if (!isJudges(a, error, raw)) return error
  const check = raw.find((r) => r.status !== 'pass' && !judged(r))
  return check ? checkFailure([check]) : error
}

/**
 * Why the attempt failed, into the record: the eval's own timeout, a cancel, an infra error, or an
 * assertion, which is the judge's when `error`, from `attemptError`, is a judge's. A judge's that
 * only a provider outage caused is an infra error, so `--retry-errors` and `--resume` run it again.
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
  if (error instanceof ProviderStopError && !timedOut) record.error.provider = { ...error.stop }
  if (record.error.kind === 'assertion' && isJudges(a, error, raw)) {
    record.error.kind = judgeOutage(a, error, raw) ? 'infra' : 'judge'
  }
  record.outcome = record.error.kind === 'infra' ? 'infra_error' : 'fail'
}

/** What the sandbox gave the attempt and what it used, into the record, before the sandbox goes. */
export async function recordResources(a: Attempt): Promise<void> {
  const resources = await a.meter?.stop({ gone: a.signal.aborted }).catch(() => undefined)
  if (!resources) return
  a.record.resources = resources
  debugLog('teardown', `resources ${resourcesLine(resources)}`)
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

/** The gateway tags entries with the phase it was switched to, which is always one of the attempt's. */
const phased = <T extends { phase?: string }>(entry: T): T & { phase?: 'setup' | 'agent' } =>
  entry as T & { phase?: 'setup' | 'agent' }

/**
 * The attempt's egress policy and, when its sandbox records it, what it contacted and was refused.
 * Refused hosts the harness always tries (in a session like this one) are `expectedBlocked`,
 * summarized in one `-v` line. Names that didn't resolve are `unresolved`, never `blocked`.
 */
export function recordEgress(a: Attempt, sandbox: Sandbox | undefined): void {
  const traffic = sandbox?.traffic?.()
  const expected = expectedBlockedFor(
    a.spec.harness,
    (a.env?.plugins.length ?? 0) > 0,
    a.spec.vertex,
  )
  const refused = traffic?.blocked ?? []
  // The harness runs only in the agent phase, so a refusal setup met is never its own.
  const isExpected = (h: { host: string; phase?: string }) =>
    h.phase !== 'setup' && !!expected?.hosts.includes(h.host)
  const expectedBlocked = refused.filter(isExpected)
  const { setup } = a.spec.egress
  const direct = isDirect(a.spec.egress.policy) || (!!setup && isDirect(setup.policy))
  a.record.egress = {
    policy: a.spec.egress.policy,
    allowed: allowedHosts(a.spec.egress),
    ...(setup ? { setup: { policy: setup.policy, allowed: allowedHosts(setup) } } : {}),
    recorded: !!traffic,
    ...(traffic && direct ? { partial: true as const } : {}),
    contacted: (traffic?.contacted ?? []).map(phased),
    blocked: refused.filter((h) => !isExpected(h)).map(phased),
    expectedBlocked: expectedBlocked.map(phased),
    unresolved: (traffic?.unresolved ?? []).map(phased),
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
  const strays = sandbox?.secretWarnings?.() ?? []
  if (strays.length) a.record.secretWarnings = strays
}

/**
 * Each turn's model calls and inferred tool durations in its transcript, and where its time
 * went. After teardown, so a stream that outlived its turn (Cursor's) has ended.
 */
export function recordTimeline(a: Attempt, sandbox: Sandbox | undefined): void {
  const calls = sandbox?.modelCalls?.() ?? []
  for (const turn of a.record.turns) {
    const events = inferDurations(
      [
        ...turn.transcript,
        ...modelCallEvents(calls, {
          startedAt: Date.parse(turn.startedAt),
          durationMs: turn.durationMs,
          model: turn.model,
          steps: a.turnSteps.get(turn) ?? [],
        }),
      ].sort((x, y) => x.atMs - y.atMs),
      turn.durationMs,
    )
    turn.transcript = events
    turn.timeSplit = timeSplit(events, turn.durationMs)
  }
  const split = sumSplits(a.record.turns.map((t) => t.timeSplit))
  if (split) a.record.timeSplit = split
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
    new Map([...a.artifactBlobs, ...a.stepBlobs]),
    a.capturePages,
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
      question: clip(redactSecrets(j.question), 200),
    })),
    turnErrors: turnErrors(record.turns.map((t) => t.transcript)),
    ...failedChecks(record),
    ...(record.error?.prepare
      ? { prepare: { ref: record.error.prepare.ref, stage: record.error.prepare.stage } }
      : {}),
  }
}

/** The record's checks that didn't pass, for the terminal; unset when all did. */
function failedChecks(record: EvalRecord): Pick<EvalMeta, 'failedChecks'> {
  const failed = (record.assertions ?? []).filter(
    (x) => x.status !== 'pass' && x.status !== 'not_applicable',
  )
  if (!failed.length) return {}
  return {
    failedChecks: failed.map((x) => ({
      label: x.label,
      ...(x.at ? { at: x.at } : {}),
      message: clip(x.message?.split('\n')[0] ?? x.reason?.split('\n')[0] ?? '', 500),
    })),
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
