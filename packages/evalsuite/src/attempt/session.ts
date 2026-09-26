import { snapshot } from '../diff.ts'
import { type ResolvedEnvironment, type ResolvedStep, skillFiles } from '../environment/resolve.ts'
import { brokeringFor } from '../harness/agents.ts'
import { createHarness, workspaceSkillDir } from '../harness/index.ts'
import type { HarnessSession } from '../harness/types.ts'
import { createSandbox, InfraError, type Sandbox } from '../sandbox/index.ts'
import { brokerPhases } from '../sandbox/phases.ts'
import { clip, formatDuration } from '../text.ts'
import { asCheck } from './checks.ts'
import { type Attempt, setupAllowance } from './state.ts'

const tailOf = (text: string) => text.trim().split('\n').slice(-10).join('\n')

/** Setup steps in order, each with its own timeout; a failure is an infra error. */
async function runSetup(a: Attempt, box: Sandbox, env: ResolvedEnvironment) {
  const { record, spec } = a
  const steps: ResolvedStep[] = env.setup
  record.setup = []
  for (const [i, step] of steps.entries()) {
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
      return null
    })
    const durationMs = Math.round(performance.now() - start)
    const output = r ? [r.stdout, r.stderr].filter(Boolean).join('\n') : ''
    record.setup.push({ run: step.run, exitCode: r?.exitCode ?? null, durationMs, output })
    if (r?.exitCode === 0) continue
    const what = `setup step ${i + 1}/${steps.length} "${clip(step.run, 80)}" in environment ${spec.environment.name}`
    throw new InfraError(
      r
        ? `${what} exited ${r.exitCode} after ${formatDuration(durationMs)} (see setup.log):\n${tailOf(r.stderr || r.stdout)}`
        : `${what} timed out after ${formatDuration(step.timeoutMs)} (see setup.log)`,
    )
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
    substitutions: env.substitutions,
  })
  a.sandbox = box
  a.phases = brokerPhases(box, env.substitutions)
  if (a.signal.aborted) void box.destroy()
  a.signal.throwIfAborted()
  await a.phases.start()
  for (const f of env.files) await box.writeFile(f.path, f.content)
  const skillDir = workspaceSkillDir(spec.harness)
  for (const skill of env.workspaceSkills) {
    for (const f of skillFiles(skill)) {
      await box.writeFile(`${skillDir}/${skill.name}/${f.path}`, f.content)
    }
  }
  await runSetup(a, box, env)
  await snapshot(box, a.signal)
  const harness = await createHarness(spec.harness)
  const session = await harness.start(box, a.signal, {
    skills: env.skills,
    workspaceSkills: env.workspaceSkills.map((s) => s.name),
    mcp: env.mcp,
  })
  a.session = session
  a.report({ kind: 'sandbox-ready', ms: Math.round(performance.now() - setupStart) })
  return [box, session]
}
