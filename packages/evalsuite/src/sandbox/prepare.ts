import {
  buildEnvironmentLayer,
  buildImage,
  DEFAULT_IMAGE,
  environmentLayerTag,
  harnessImageFor,
  type ImageInfo,
  imageInfo,
  LABEL,
} from '@evalsuite/sandbox-docker'
import { withLease } from '../scheduler/client.ts'
import type { AttemptImage, DockerSandboxDescriptor } from '../types.ts'
import { InfraError } from './types.ts'

/**
 * One image build at a time across the run's workers. Whoever gets the lease looks for the
 * image again first, so attempts that asked for the same image while it was building reuse it.
 */
const BUILD_LIMIT = { 'image-build': 1 }

async function buildOnce(
  ref: string,
  build: () => Promise<unknown>,
  signal: AbortSignal,
): Promise<ImageInfo | null> {
  try {
    return await withLease(
      BUILD_LIMIT,
      async () => {
        const built = await imageInfo(ref)
        if (built) return built
        await build()
        return imageInfo(ref)
      },
      signal,
    )
  } catch (error) {
    if (signal.aborted) throw error
    throw new InfraError((error as Error).message)
  }
}

/**
 * The image an attempt's container starts from: the sandbox image (built from `from` on first
 * use), plus a cached layer with the environment's baked `exec` steps.
 */
export async function prepareImage(
  sandbox: DockerSandboxDescriptor,
  baked: string[],
  signal: AbortSignal,
): Promise<AttemptImage> {
  if (sandbox.image && sandbox.from) {
    throw new InfraError('docker() takes either image or from, not both')
  }
  let ref = sandbox.image ?? (sandbox.from ? harnessImageFor(sandbox.from) : DEFAULT_IMAGE)
  let info = await imageInfo(ref)
  if (!info && sandbox.from) {
    const from = sandbox.from
    const log = (line: string) => process.env.ES_DEBUG && console.error(line)
    info = await buildOnce(ref, () => buildImage(log, { from, signal }), signal)
  }
  if (!info) throw new InfraError(`Docker image ${ref} not found. Build it with: es image build`)
  const agentCli = info.labels[LABEL.agentVersion] ?? null
  if (baked.length > 0) {
    const parent = { ref, id: info.id }
    ref = environmentLayerTag(parent, baked)
    info =
      (await imageInfo(ref)) ??
      (await buildOnce(ref, () => buildEnvironmentLayer(parent, baked, signal), signal))
    if (!info) throw new InfraError(`The environment layer ${ref} disappeared after building`)
  }
  return { ref, id: info.id, agentCli }
}
