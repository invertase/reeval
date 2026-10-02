import { parseDuration } from '../config.ts'
import type { ResolvedEnvironment } from '../environment/resolve.ts'
import type { HarnessSession } from '../harness/types.ts'
import type { PlannedAttempt } from '../options.ts'
import type { Sandbox } from '../sandbox/index.ts'
import type { BrokerPhases } from '../sandbox/phases.ts'
import type {
  BackgroundHandle,
  CaptureOptions,
  EnvVars,
  EvalRecord,
  HarnessDescriptor,
  JudgeOptions,
  Turn,
} from '../types.ts'
import type { ProgressUpdate } from '../ui/events.ts'

/** Extra time an attempt gets, outside its eval timeout, when its image may need building. */
const SETUP_BUDGET_MS = 20 * 60_000

/** One planned attempt with what its eval resolved: the input to every phase of the attempt. */
export type AttemptSpec = PlannedAttempt & {
  name: string
  groups: string[]
  timeoutMs: number
  env: EnvVars
  judge: JudgeOptions
  capture: CaptureOptions
  /** Which level set each option; unset means the config or its default. */
  sources: Partial<Record<string, string>>
  /** What the profile's limit changed. */
  notes: string[]
}

/**
 * One attempt as it runs. Each phase (environment, session, turns, checks and judge, record)
 * reads it and adds to it; the record is what gets written at the end, whatever happened.
 */
export type Attempt = {
  readonly spec: AttemptSpec
  readonly record: EvalRecord
  readonly turns: Turn[]
  readonly report: (update: ProgressUpdate) => void
  /** Runs `fn`, adding its duration to the record's timing for `phase`. */
  readonly timed: <T>(phase: keyof EvalRecord['timings'], fn: () => Promise<T>) => Promise<T>
  /** The test's signal while the environment is prepared; after that, the eval's timer too. */
  signal: AbortSignal
  /** Once the environment is resolved. */
  env?: ResolvedEnvironment
  /** The image the Docker sandbox starts from, once prepared. */
  image?: string
  /** As soon as it exists, so teardown can remove it even when the start fails later. */
  sandbox?: Sandbox
  session?: HarnessSession
  phases?: BrokerPhases
  /** A judge call failed or had no model: a failed assertion is then the judge's. */
  judgeErrored: boolean
  /** Judge calls that failed without throwing, which fail the attempt once the eval's body is done. */
  judgeErrors: string[]
  /** `c.capture()` names already used in this attempt. */
  captureNames: Set<string>
  /** Background processes from `c.exec({ background })` / `c.serve`; teardown kills leftovers. */
  backgrounds: BackgroundHandle[]
  /** PNG bytes keyed by capture name; written as sidecars next to the staging JSON. */
  artifactBlobs: Map<string, Buffer>
}

export function createAttempt(
  spec: AttemptSpec,
  signal: AbortSignal,
  progress: (update: ProgressUpdate & { at: number }) => void,
): Attempt {
  const record: EvalRecord = {
    startedAt: new Date().toISOString(),
    outcome: 'pass',
    error: null,
    turns: [],
    diff: null,
    checks: [],
    judgements: [],
    timings: { setupMs: 0, agentMs: 0, diffMs: 0, checksMs: 0, judgeMs: 0 },
    judgeInputs: [],
  }
  return {
    spec,
    record,
    turns: [],
    report: (update) => progress({ at: Date.now(), ...update }),
    async timed(phase, fn) {
      const start = performance.now()
      try {
        return await fn()
      } finally {
        record.timings[phase] += Math.round(performance.now() - start)
      }
    },
    signal,
    judgeErrored: false,
    judgeErrors: [],
    captureNames: new Set(),
    backgrounds: [],
    artifactBlobs: new Map(),
  }
}

/** How long a harness session may take to become ready, unless its `startTimeout` says. */
export const DEFAULT_START_TIMEOUT = '90s'

export const startTimeoutMs = (harness: HarnessDescriptor): number =>
  parseDuration(harness.startTimeout ?? DEFAULT_START_TIMEOUT)

/**
 * Setup steps and the harness's start (once retried) run outside the eval timeout, so the
 * attempt's own limit makes room for them.
 */
export function setupAllowance(planned: PlannedAttempt): number {
  const layers = planned.environment.layers
  const steps = layers.flatMap((l) => l.spec.setup ?? [])
  const setupMs = steps.reduce(
    (ms, step) => ms + parseDuration((typeof step === 'string' ? undefined : step.timeout) ?? '5m'),
    0,
  )
  const { sandbox } = planned
  const building =
    sandbox.kind === 'docker' && !!(sandbox.from || sandbox.dockerfile || sandbox.install?.length)
  return setupMs + (building ? SETUP_BUDGET_MS : 0) + 2 * startTimeoutMs(planned.harness)
}

/** The eval's timer, paused while the sandbox and its setup steps start. */
export function evalTimer(ms: number) {
  const controller = new AbortController()
  let left = ms
  let since = Date.now()
  let timer: NodeJS.Timeout | undefined
  const fire = () =>
    controller.abort(new DOMException(`Eval timed out after ${ms / 1000}s`, 'TimeoutError'))
  const start = () => {
    since = Date.now()
    timer = setTimeout(fire, Math.max(0, left))
  }
  start()
  return {
    signal: controller.signal,
    pause() {
      clearTimeout(timer)
      left -= Date.now() - since
    },
    resume: start,
    clear: () => clearTimeout(timer),
  }
}
