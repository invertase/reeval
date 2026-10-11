import { attemptDebug, debugLog } from '../debug/attempt.ts'
import { resolveEnvironment } from '../environment/resolve.ts'
import { layoutOf } from '../harness/index.ts'
import { InfraError } from '../sandbox/types.ts'
import type { AttemptImage } from '../types.ts'
import { preparedWorkspace } from '../workspace.ts'
import { traceEnvironment } from './debug.ts'
import type { Attempt } from './state.ts'

/**
 * Resolves the attempt's environment (files, skills, secrets and their placeholders)
 * and finds the image a Docker sandbox starts from, which preflight prepared. Runs on the test's
 * signal, before the eval timer starts.
 */
export async function prepareEnvironment(
  a: Attempt,
  root: string,
  runId: string,
  where: string,
  signal: AbortSignal,
): Promise<void> {
  const { spec, record } = a
  const env = await resolveEnvironment(
    spec.environment,
    spec.env,
    root,
    where,
    layoutOf(spec.harness).rulesFile,
    spec.egress.policy,
    (w) => preparedWorkspace(root, runId, w),
  )
  a.env = env
  record.environment = env.record
  const { secrets, brokered } = env.record
  record.env = {
    vars: Object.keys(env.vars)
      .filter((n) => !secrets.includes(n))
      .sort(),
    secrets,
    brokered,
  }
  const debug = attemptDebug()
  if (debug) traceEnvironment(debug, spec, env)
  record.image = null
  if (spec.sandbox.kind === 'docker') {
    const { preparedFor } = await import('../sandbox/preflight.ts')
    const { dockerProvider } = await import('../sandbox/providers.ts')
    signal.throwIfAborted()
    // Preflight prepared every image before the run: an attempt only looks its image up.
    const prepared = preparedFor(root, runId, dockerProvider(), spec.sandbox, spec.harness)
    if (!prepared) {
      throw new InfraError(`The sandbox image for ${where} wasn't prepared before the run started`)
    }
    record.image = prepared as unknown as AttemptImage
    a.image = record.image.ref
    const { ref, id, base, install, agentCli } = record.image
    debugLog(
      'image',
      `ready ${ref} (${id.replace(/^sha256:/, '').slice(0, 12)}) · prepared before the run${ref !== base ? ` · on ${base}` : ''}${agentCli ? ` · agent CLI ${agentCli}` : ''}${install.length ? ` · install: ${install.join(' && ')}` : ''}`,
    )
  } else {
    debugLog('image', `none: the ${spec.sandbox.kind} sandbox runs on the host`)
  }
}
