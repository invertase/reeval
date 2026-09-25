import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BAKED_HARNESSES,
  type BakedHarness,
  buildEnvironmentLayer,
  buildImage,
  environmentLayerTag,
  harnessImageFor,
  type ImageInfo,
  imageFor,
  imageInfo,
  isBakedHarness,
  LABEL,
  type LayerStep,
} from '@evalsuite/sandbox-docker'
import { UsageError } from '../errors.ts'
import { withLease } from '../scheduler/client.ts'
import type { AttemptImage, DockerSandboxDescriptor, HarnessDescriptor } from '../types.ts'
import { InfraError } from './types.ts'

/** The harness whose image an attempt runs in; the fake harness runs in the default one. */
export const bakedHarnessFor = (harness: HarnessDescriptor): BakedHarness =>
  harness.kind === 'fake' ? 'cursor' : harness.kind

/** How to get a missing image: `es image build <harness>` for a harness image, else by hand. */
export function imageHint(ref: string): string {
  const baked = BAKED_HARNESSES.find((h) => imageFor(h) === ref)
  return baked ? `Build it once with: es image build ${baked}` : 'Pull or build it first'
}

/**
 * The images `es image build` makes: the named harnesses, or else the config's. Throws before
 * anything is built if a name isn't a harness with an image.
 */
export function imageBuildTargets(
  named: readonly string[],
  configured: readonly HarnessDescriptor[],
): BakedHarness[] {
  const unknown = named.filter((name) => !isBakedHarness(name))
  if (unknown.length) {
    throw new UsageError(
      `Unknown harness "${unknown.join('", "')}". Use one of: ${BAKED_HARNESSES.join(', ')}`,
    )
  }
  return [...new Set(named.length ? named.filter(isBakedHarness) : configured.map(bakedHarnessFor))]
}

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
 * use), plus a cached layer with the environment's `image` steps. Each layer's build log goes to
 * `.es/cache/images/<hash>.log` under `root`.
 */
export async function prepareImage(
  sandbox: DockerSandboxDescriptor,
  harness: HarnessDescriptor,
  steps: LayerStep[],
  root: string,
  signal: AbortSignal,
): Promise<AttemptImage> {
  if (sandbox.image && sandbox.from) {
    throw new InfraError('docker() takes either image or from, not both')
  }
  const baked = bakedHarnessFor(harness)
  let ref = sandbox.image ?? (sandbox.from ? harnessImageFor(baked, sandbox.from) : imageFor(baked))
  let info = await imageInfo(ref)
  if (!info && sandbox.from) {
    const from = sandbox.from
    const log = (line: string) => process.env.ES_DEBUG && console.error(line)
    info = await buildOnce(ref, () => buildImage(log, { harness: baked, from, signal }), signal)
  }
  if (!info) {
    throw new InfraError(`Docker image ${ref} not found. ${imageHint(ref)}`)
  }
  const agentCli = info.labels[LABEL.agentVersion] ?? null
  if (steps.length > 0) {
    const parent = { ref, id: info.id }
    ref = environmentLayerTag(parent, steps)
    const logFile = join(root, '.es', 'cache', 'images', `${ref.split(':')[1]}.log`)
    const log = (output: string) => {
      mkdirSync(join(root, '.es', 'cache', 'images'), { recursive: true })
      writeFileSync(logFile, output)
    }
    try {
      info =
        (await imageInfo(ref)) ??
        (await buildOnce(ref, () => buildEnvironmentLayer(parent, steps, { signal, log }), signal))
    } catch (error) {
      if (signal.aborted) throw error
      throw new InfraError(`${(error as Error).message}\n(full log: ${logFile})`)
    }
    if (!info) throw new InfraError(`The environment layer ${ref} disappeared after building`)
  }
  return { ref, id: info.id, agentCli }
}
