import { attemptDebug, debugLog } from '../debug/attempt.ts'
import { resolveEnvironment } from '../environment/resolve.ts'
import { layoutOf } from '../harness/index.ts'
import { formatDuration } from '../text.ts'
import { traceEnvironment } from './debug.ts'
import type { Attempt } from './state.ts'

/**
 * Phase 1: resolves the attempt's environment (files, skills, secrets and their placeholders)
 * and prepares the image a Docker sandbox starts from. Runs on the test's signal, before the eval
 * timer starts, since an image build can take minutes.
 */
export async function prepareEnvironment(
  a: Attempt,
  root: string,
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
    const { imageHarness, prepareImage } = await import('../sandbox/prepare.ts')
    const harness = imageHarness(spec.harness)
    const start = performance.now()
    record.image = await prepareImage(spec.sandbox, harness, root, signal)
    a.image = record.image.ref
    const { ref, id, base, install, agentCli } = record.image
    debugLog(
      'image',
      `ready ${ref} (${id.replace(/^sha256:/, '').slice(0, 12)}) in ${formatDuration(performance.now() - start)}${ref !== base ? ` · on ${base}` : ''}${agentCli ? ` · agent CLI ${agentCli}` : ''}${install.length ? ` · install: ${install.join(' && ')}` : ''}`,
    )
  } else {
    debugLog('image', `none: the ${spec.sandbox.kind} sandbox runs on the host`)
  }
}
