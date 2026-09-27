import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  type BakedHarness,
  buildDockerfile,
  buildImage,
  buildInstallLayer,
  dockerfileTag,
  ES_BASE_ARG,
  harnessImageFor,
  harnessLabel,
  type ImageInfo,
  type InstallStep,
  imageFor,
  imageInfo,
  installLayerTag,
  LABEL,
  retryTransient,
  usesEsBase,
} from '@evalsuite/sandbox-docker'
import { parseDuration } from '../config.ts'
import { debugLog } from '../debug/attempt.ts'
import '../debug/docker.ts'
import { stepCommand } from '../environment.ts'
import { withLease } from '../scheduler/client.ts'
import type { AttemptImage, DockerSandboxDescriptor, HarnessDescriptor } from '../types.ts'
import { InfraError } from './types.ts'

/** Whose CLI a harness's image carries. The fake harness runs in its `layout`'s, else Cursor's. */
export const imageHarness = (harness: HarnessDescriptor): BakedHarness =>
  harness.kind === 'fake' ? (harness.layout ?? 'cursor') : harness.kind

/**
 * One image build at a time across the run's workers. Whoever gets the lease looks for the
 * image again first, so attempts that asked for the same image while it was building reuse it.
 */
const BUILD_LIMIT = { 'image-build': 1 }

async function buildOnce(
  ref: string,
  build: () => Promise<unknown>,
  signal: AbortSignal,
  force = false,
): Promise<ImageInfo | null> {
  try {
    return await withLease(
      BUILD_LIMIT,
      async () => {
        const built = force ? null : await imageInfo(ref)
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

/** The sandbox's `install` commands, with their timeouts in ms. */
export const installSteps = (sandbox: DockerSandboxDescriptor): InstallStep[] =>
  (sandbox.install ?? []).map((step) =>
    typeof step === 'string'
      ? { run: step }
      : {
          run: step.run,
          ...(step.timeout !== undefined ? { timeoutMs: parseDuration(step.timeout) } : {}),
        },
  )

export { usesEsBase }

export const projectPath = (root: string, path: string) =>
  relative(root, path).split(sep).join('/') || '.'

/** Rebuild harness images and Dockerfiles once each, even when they exist (`es image build`). */
export type Rebuild = { done: Set<string> }

type PrepareOptions = {
  /** Progress lines, e.g. for `es image build`. */
  log?: (line: string) => void
  rebuild?: Rebuild
}

const buildLogger = (root: string, ref: string) => {
  const dir = join(root, '.es', 'cache', 'images')
  const file = join(dir, `${ref.replace(/[^A-Za-z0-9._-]+/g, '-')}.log`)
  return {
    file,
    path: projectPath(root, file),
    write: (output: string) => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, output)
    },
  }
}

/** A build, tried again after a registry or network error, and never after any other. */
const retried = <T>(build: () => Promise<T>, signal: AbortSignal) =>
  retryTransient(build, {
    signal,
    onRetry: (error) =>
      debugLog('image', `transient failure, retrying: ${error.message.split('\n')[0]}`),
  })

/**
 * The image with the harness in it that the sandbox's `install` layer (if any) goes on: ES's
 * image for the harness, `image` as is, `from` with Node and the harness baked on, or the built
 * Dockerfile (with them baked on unless it's built on that harness's image).
 */
async function harnessBase(
  sandbox: DockerSandboxDescriptor,
  harness: BakedHarness,
  root: string,
  signal: AbortSignal,
  options: PrepareOptions,
): Promise<{ ref: string; info: ImageInfo; dockerfile: AttemptImage['dockerfile'] }> {
  const log = options.log ?? ((line: string) => process.env.ES_DEBUG && console.error(line))
  const rebuild = (ref: string) => {
    if (!options.rebuild || options.rebuild.done.has(ref)) return false
    options.rebuild.done.add(ref)
    return true
  }
  const bake = async (from: string) => {
    const ref = harnessImageFor(harness, from)
    const force = rebuild(ref)
    const cached = force ? null : await imageInfo(ref)
    if (cached) debugLog('image', `cache hit ${ref} (${from} with the ${harness} CLI baked on)`)
    else debugLog('image', `building ${ref}: ${from} with Node, git and the ${harness} CLI`)
    const output = buildLogger(root, ref)
    const info =
      cached ??
      (await buildOnce(
        ref,
        () => retried(() => buildImage(log, { harness, from, signal, output }), signal),
        signal,
        force,
      ))
    if (!info) throw new InfraError(`The sandbox image ${ref} disappeared after building`)
    return { ref, info }
  }

  if (sandbox.image) {
    const info = await imageInfo(sandbox.image)
    if (!info) {
      throw new InfraError(
        `Docker image ${sandbox.image} not found. docker({ image }) is used as is, so pull or build it first (or use from or dockerfile to have ES build it).`,
      )
    }
    debugLog('image', `using ${sandbox.image} as is (docker({ image }))`)
    return { ref: sandbox.image, info, dockerfile: null }
  }
  if (sandbox.from) return { ...(await bake(sandbox.from)), dockerfile: null }
  if (sandbox.dockerfile) {
    const path = sandbox.dockerfile
    const esBase = usesEsBase(path) ? ((await imageInfo(imageFor(harness)))?.id ?? null) : null
    const { tag, sha256 } = dockerfileTag(path, harness, esBase)
    const dockerfile = { path: projectPath(root, path), sha256 }
    if (usesEsBase(path) && !esBase) {
      throw new InfraError(
        `${dockerfile.path} starts FROM \${${ES_BASE_ARG}}, and ${imageFor(harness)} isn't built. Build it once with: es image build`,
      )
    }
    const force = rebuild(tag)
    const output = buildLogger(root, tag)
    log(`Building ${dockerfile.path} as ${tag}`)
    const cached = force ? null : await imageInfo(tag)
    debugLog(
      'image',
      cached
        ? `cache hit ${tag} (${dockerfile.path}, context ${sha256.slice(0, 12)})`
        : `building ${dockerfile.path} as ${tag} (log: ${output.path})`,
    )
    const built =
      cached ??
      (await buildOnce(
        tag,
        () =>
          retried(
            () =>
              buildDockerfile(path, {
                harness,
                esBase,
                name: dockerfile.path,
                signal,
                output,
                force: true,
              }),
            signal,
          ),
        signal,
        force,
      ))
    if (!built) throw new InfraError(`The image ${tag} disappeared after building`)
    // Built on this harness's image, so its CLI is already there. Any other base, including
    // another harness's image, gets this harness baked on.
    if (built.labels[LABEL.harness] === harnessLabel(harness)) {
      return { ref: tag, info: built, dockerfile }
    }
    return { ...(await bake(tag)), dockerfile }
  }
  const ref = imageFor(harness)
  const info = await imageInfo(ref)
  if (!info) throw new InfraError(`Docker image ${ref} not found. Build it with: es image build`)
  debugLog('image', `cache hit ${ref} (ES's image for ${harness}; es image build rebuilds it)`)
  return { ref, info, dockerfile: null }
}

/**
 * The image an attempt's container starts from: the sandbox's image for the harness (built on
 * first use for `from` and `dockerfile`), plus a cached layer with its `install` commands. Each
 * build's log goes to `.es/cache/images/` under `root`.
 */
export async function prepareImage(
  sandbox: DockerSandboxDescriptor,
  harness: BakedHarness,
  root: string,
  signal: AbortSignal,
  options: PrepareOptions = {},
): Promise<AttemptImage> {
  const base = await harnessBase(sandbox, harness, root, signal, options)
  const agentCli = base.info.labels[LABEL.agentVersion] ?? null
  const steps = installSteps(sandbox)
  const install = (sandbox.install ?? []).map(stepCommand)
  const image = { agentCli, base: base.ref, install, dockerfile: base.dockerfile }
  if (steps.length === 0) return { ref: base.ref, id: base.info.id, ...image }

  const parent = { ref: base.ref, id: base.info.id }
  const ref = installLayerTag(parent, steps)
  const output = buildLogger(root, ref)
  let info = await imageInfo(ref)
  if (info) {
    debugLog('image', `cache hit ${ref}: install layer on ${base.ref}, no install steps ran`)
  } else {
    debugLog(
      'image',
      `building ${ref} on ${base.ref}: running install ${steps.map((s, i) => `${i + 1}. ${s.run}`).join(' ')} (log: ${output.path})`,
    )
    options.log?.(`Installing ${steps.length} command(s) onto ${base.ref} as ${ref}`)
    info = await buildOnce(ref, () => buildInstallLayer(parent, steps, { signal, output }), signal)
  }
  if (!info) throw new InfraError(`The install layer ${ref} disappeared after building`)
  return { ref, id: info.id, ...image }
}
