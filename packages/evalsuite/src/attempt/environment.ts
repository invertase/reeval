import { resolveEnvironment } from '../environment/resolve.ts'
import { layoutOf } from '../harness/index.ts'
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
  record.image = null
  if (spec.sandbox.kind === 'docker') {
    const { imageHarness, prepareImage } = await import('../sandbox/prepare.ts')
    const harness = imageHarness(spec.harness)
    record.image = await prepareImage(spec.sandbox, harness, root, signal)
    a.image = record.image.ref
  }
}
