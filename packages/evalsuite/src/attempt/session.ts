import { debugLog, debugTrace } from '../debug/attempt.ts'
import { snapshot } from '../diff.ts'
import { type ResolvedEnvironment, type ResolvedStep, skillFiles } from '../environment/resolve.ts'
import { brokeringFor, expectedBlockedFor } from '../harness/agents.ts'
import { createHarness, layoutOf, workspaceSkillDir } from '../harness/index.ts'
import type { Harness, HarnessSession } from '../harness/types.ts'
import { harnessId } from '../options.ts'
import { createSandbox, InfraError, type Sandbox } from '../sandbox/index.ts'
import { brokerPhases } from '../sandbox/phases.ts'
import { clip, formatDuration } from '../text.ts'
import { asCheck } from './checks.ts'
import { type Attempt, setupAllowance, startTimeoutMs } from './state.ts'

const tailOf = (text: string) => text.trim().split('\n').slice(-10).join('\n')

/** Setup steps in order, each with its own timeout; a failure is an infra error. */
async function runSetup(a: Attempt, box: Sandbox, env: ResolvedEnvironment) {
  const { record, spec } = a
  const steps: ResolvedStep[] = env.setup
  record.setup = []
  for (const [i, step] of steps.entries()) {
    const what = `setup step ${i + 1}/${steps.length} "${clip(step.run, 80)}" in environment ${spec.environment.name}`
    const start = performance.now()
    const stepSignal = AbortSignal.any([a.signal, AbortSignal.timeout(step.timeoutMs)])
    const r = await asCheck(a, () =>
      box.exec(step.run, {
        signal: stepSignal,
        env: env.checkVars,
        ...(step.cwd ? { cwd: step.cwd } : {}),
      }),
    ).catch((error) => {
      if (a.signal.aborted) throw error
      if (!stepSignal.aborted) {
        throw new InfraError(
          `${what} couldn't run: ${error instanceof Error ? error.message : error}`,
        )
      }
      return null
    })
    const durationMs = Math.round(performance.now() - start)
    const output = r ? [r.stdout, r.stderr].filter(Boolean).join('\n') : ''
    record.setup.push({ run: step.run, exitCode: r?.exitCode ?? null, durationMs, output })
    debugLog(
      'env',
      `setup ${i + 1}/${steps.length} $ ${clip(step.run, 120)} → ${r ? `exit ${r.exitCode}` : `timed out after ${formatDuration(step.timeoutMs)}`} · ${formatDuration(durationMs)}${step.cwd ? ` · in ${step.cwd}` : ''}`,
    )
    debugTrace(
      'env',
      'setup',
      {
        run: step.run,
        cwd: step.cwd,
        exitCode: r?.exitCode ?? null,
        durationMs,
        stdout: r?.stdout,
        stderr: r?.stderr,
      },
      `setup ${i + 1} output`,
    )
    if (r?.exitCode === 0) continue
    throw new InfraError(
      r
        ? `${what} exited ${r.exitCode} after ${formatDuration(durationMs)} (see setup.log):\n${tailOf(r.stderr || r.stdout)}`
        : `${what} timed out after ${formatDuration(step.timeoutMs)} (see setup.log)`,
    )
  }
}

/**
 * Starts the harness session within its `startTimeout`. A start that doesn't become ready in time
 * is aborted (and closed, should it finish later) and started once more: a stuck bootstrap is
 * usually transient, and nothing has run yet, so the retry can't change what the attempt
 * measures. A second timeout is an infra error; a start that fails outright isn't retried.
 */
async function startHarness(
  a: Attempt,
  harness: Harness,
  box: Sandbox,
  options: Parameters<Harness['start']>[2],
): Promise<HarnessSession> {
  const { harness: descriptor } = a.spec
  const ms = startTimeoutMs(descriptor)
  const late = `${descriptor.kind}: session did not become ready within ${formatDuration(ms)}`
  for (let tries = 1; ; tries++) {
    const stop = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms)
    })
    const starting = harness.start(box, AbortSignal.any([a.signal, stop.signal]), options)
    const session = await Promise.race([starting, timedOut]).finally(() => clearTimeout(timer))
    if (session) return session
    stop.abort(new InfraError(late))
    starting.then(
      (s) => s.close().catch(() => {}),
      () => {},
    )
    a.signal.throwIfAborted()
    if (tries === 2) throw new InfraError(`${late} (tried twice)`)
    a.record.startRetries = [{ error: late, waitedMs: ms }]
    debugLog('harness', `${late}; starting it once more`)
  }
}

/**
 * Phase 2: starts the sandbox (with the brokered secrets its gateway swaps in), writes the
 * environment's files and workspace skills, runs its setup steps, snapshots the workspace for
 * the diff, and starts the harness session with the harness-placed skills and MCP servers.
 */
export async function startSession(
  a: Attempt,
  runId: string,
  setupStart: number,
): Promise<[Sandbox, HarnessSession]> {
  const { spec } = a
  const env = a.env as ResolvedEnvironment
  const box = await createSandbox(spec.sandbox, {
    runId,
    timeoutMs: spec.timeoutMs + setupAllowance(spec) + 60_000,
    signal: a.signal,
    env: env.vars,
    image: a.image,
    brokering: brokeringFor(spec.harness),
    expectedBlocked: expectedBlockedFor(spec.harness)?.hosts,
    substitutions: env.substitutions,
    egress: spec.egress,
  })
  a.sandbox = box
  if (spec.sandbox.kind === 'fake') debugLog('container', `fake sandbox at ${box.workdir}`)
  a.phases = brokerPhases(box, env.substitutions)
  if (a.signal.aborted) void box.destroy()
  a.signal.throwIfAborted()
  await a.phases.start()
  if (env.substitutions.length) {
    const agent = env.substitutions.filter((s) => s.phase === 'agent').map((s) => s.name)
    debugLog('broker', `gateway swaps in ${agent.join(', ') || 'nothing'} for the agent`)
  }
  for (const f of env.files) {
    await box.writeFile(f.path, f.content)
    const size = typeof f.content === 'string' ? Buffer.byteLength(f.content) : f.content.byteLength
    debugLog('env', `file ${f.path} (${size} bytes)`)
  }
  const skillDir = workspaceSkillDir(spec.harness)
  for (const skill of env.workspaceSkills) {
    const files = skillFiles(skill)
    for (const f of files) {
      await box.writeFile(`${skillDir}/${skill.name}/${f.path}`, f.content)
    }
    debugLog(
      'env',
      `skill ${skill.name} → ${skillDir}/${skill.name}/ (${files.length} files, workspace)`,
    )
  }
  const layout = layoutOf(spec.harness)
  for (const skill of env.skills) {
    debugLog(
      'env',
      `skill ${skill.name} → the harness adapter places it (~/${layout.harnessSkillDir}/${skill.name}/ for ${spec.harness.kind === 'fake' ? `the fake ${spec.harness.layout ?? 'cursor'} layout` : spec.harness.kind})`,
    )
  }
  for (const [name, server] of Object.entries(env.mcp)) {
    debugLog(
      'env',
      `mcp ${name} (${server.transport}${server.transport === 'stdio' ? `: ${server.command} ${server.args.join(' ')}` : `: ${server.url}`}) → the harness adapter writes its MCP config`,
    )
  }
  await runSetup(a, box, env)
  await snapshot(box, a.signal)
  debugLog('env', 'workspace snapshot taken: the diff starts here')
  const harness = await createHarness(spec.harness)
  const harnessStart = performance.now()
  debugLog('harness', `starting ${harnessId(spec.harness)}: bootstrap and session`)
  const session = await startHarness(a, harness, box, {
    skills: env.skills,
    workspaceSkills: env.workspaceSkills.map((s) => s.name),
    mcp: env.mcp,
  })
  debugLog(
    'harness',
    `${harnessId(spec.harness)} session ready in ${formatDuration(performance.now() - harnessStart)}`,
  )
  a.session = session
  a.report({ kind: 'sandbox-ready', ms: Math.round(performance.now() - setupStart) })
  return [box, session]
}
