import type { AttemptImage, DockerSandboxDescriptor } from '../types.ts'
import { buildEnvironmentLayer, buildImage, harnessImageFor } from './build-image.ts'
import { imageInfo } from './docker-cli.ts'
import { DEFAULT_IMAGE, LABEL } from './image.ts'
import { InfraError } from './types.ts'

/** One build per image per worker, however many attempts ask for it at once. */
const building = new Map<string, Promise<unknown>>()

function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let p = building.get(key) as Promise<T> | undefined
  if (!p) {
    p = fn()
    building.set(key, p)
    p.catch(() => building.delete(key))
  }
  return p
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
    try {
      await once(ref, () =>
        buildImage((line) => process.env.ES_DEBUG && console.error(line), { from }),
      )
    } catch (error) {
      throw new InfraError((error as Error).message)
    }
    info = await imageInfo(ref)
  }
  if (!info) throw new InfraError(`Docker image ${ref} not found. Build it with: es image build`)
  const agentCli = info.labels[LABEL.agentVersion] ?? null
  if (baked.length > 0) {
    const parent = { ref, id: info.id }
    try {
      ref = await once(`${info.id}\0${JSON.stringify(baked)}`, () =>
        buildEnvironmentLayer(parent, baked, signal),
      )
    } catch (error) {
      if (signal.aborted) throw error
      throw new InfraError((error as Error).message)
    }
    info = await imageInfo(ref)
    if (!info) throw new InfraError(`The environment layer ${ref} disappeared after building`)
  }
  return { ref, id: info.id, agentCli }
}
