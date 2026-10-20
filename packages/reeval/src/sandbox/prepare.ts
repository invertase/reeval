import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  type BakedHarness,
  buildDockerfile,
  buildImage,
  buildInstallLayer,
  contextHash,
  dockerfileTag,
  type Engine,
  engineSpec,
  harnessImageFor,
  harnessLabel,
  type ImageInfo,
  type InstallStep,
  imageFor,
  imageInfo,
  installLayerTag,
  LABEL,
  resolveFrom,
  usesReevalBase,
} from '@reeval/sandbox-docker'
import { parseDuration } from '../config.ts'
import '../debug/docker.ts'
import { stepCommand } from '../environment.ts'
import type { AttemptImage, DockerSandboxDescriptor, HarnessDescriptor } from '../types.ts'
import { PrepareError } from './provider.ts'

/** Whose CLI a harness's image carries. The fake harness runs in its `layout`'s, else Cursor's. */
export const imageHarness = (harness: HarnessDescriptor): BakedHarness =>
  harness.kind === 'fake' ? (harness.layout ?? 'cursor') : harness.kind

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

export { usesReevalBase }

export const projectPath = (root: string, path: string) =>
  relative(root, path).split(sep).join('/') || '.'

/**
 * One run's image builds: each image is built at most once, and a failed build's error is kept,
 * so every target that needs the image gets it at once instead of building it again.
 */
export type Builds = {
  once: (ref: string, build: () => Promise<ImageInfo>) => Promise<ImageInfo>
  /** A step that may hit the network, retried on a transient failure. */
  retry: <T>(step: () => Promise<T>) => Promise<T>
  log: (line: string) => void
  /**
   * `none` (`reeval run`): use what's built. `check` (`reeval image build`): also rebuild a `from` image
   * whose tag moved upstream. `force` (`reeval image build --force`): rebuild and pull everything.
   */
  refresh: Refresh
  /** The container CLI every build runs on. */
  engine: Engine
}

export type Refresh = 'none' | 'check' | 'force'

export function createBuilds(options: Partial<Omit<Builds, 'once'>> = {}): Builds {
  const builds = new Map<string, Promise<ImageInfo>>()
  return {
    once: (ref, build) => {
      let done = builds.get(ref)
      if (!done) {
        done = build()
        builds.set(ref, done)
      }
      return done
    },
    retry: options.retry ?? ((step) => step()),
    log: options.log ?? (() => {}),
    refresh: options.refresh ?? 'none',
    engine: options.engine ?? 'docker',
  }
}

const buildLogger = (root: string, ref: string) => {
  const dir = join(root, '.reeval', 'cache', 'images')
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

const built = async (ref: string, engine: Engine) => {
  const info = await imageInfo(ref, engine)
  if (!info) throw new Error(`The image ${ref} disappeared after building`)
  return info
}

/** reeval's image for the harness: built when it's missing, or when reeval's base context changed. */
export const reevalImage = (
  harness: BakedHarness,
  root: string,
  signal: AbortSignal,
  b: Builds,
) => {
  const ref = imageFor(harness)
  const { engine } = b
  return b.once(ref, async () => {
    const info = await imageInfo(ref, engine)
    const current = info?.labels[LABEL.context] === contextHash()
    if (info && current && b.refresh !== 'force') return info
    b.log(info && !current ? `Rebuilding ${ref}: reeval's base image changed` : `Building ${ref}`)
    const output = buildLogger(root, ref)
    const pull = b.refresh === 'force'
    await b.retry(() => buildImage(b.log, { harness, signal, output, pull, engine }))
    return built(ref, engine)
  })
}

/**
 * The image with the harness in it that the sandbox's `install` layer (if any) goes on: reeval's
 * image for the harness, `image` as is, `from` with Node and the harness baked on, or the built
 * Dockerfile (with them baked on unless it's built on that harness's image).
 */
async function harnessBase(
  sandbox: DockerSandboxDescriptor,
  harness: BakedHarness,
  root: string,
  signal: AbortSignal,
  b: Builds,
): Promise<{ ref: string; info: ImageInfo; dockerfile: AttemptImage['dockerfile'] }> {
  const { engine } = b
  const bake = (from: string) => {
    const ref = harnessImageFor(harness, from)
    return b.once(ref, async () => {
      const cached = b.refresh === 'force' ? null : await imageInfo(ref, engine)
      if (cached && b.refresh === 'check') {
        // `reeval image build` refreshes a tag that moved upstream; a pinned digest never moves.
        const now = await resolveFrom(from, signal, engine)
        const was = cached.labels[LABEL.fromDigest]
        if ('digest' in now && was && now.digest !== was) {
          b.log(`Rebuilding ${ref}: ${from} moved upstream`)
        } else return cached
      } else if (cached) return cached
      const output = buildLogger(root, ref)
      const pull = b.refresh === 'force'
      await b.retry(() => buildImage(b.log, { harness, from, signal, output, pull, engine }))
      return built(ref, engine)
    })
  }

  if (sandbox.image) {
    const image = sandbox.image
    const info = await b.once(image, async () => {
      const found = await imageInfo(image, engine)
      if (found) return found
      const { name, fn } = engineSpec(engine)
      throw new PrepareError({
        class: 'config',
        stage: 'image',
        ref: image,
        cause: null,
        log: null,
        usage: true,
        message: `${name} image ${image} not found. ${fn}({ image }) is used as is, so pull or build it first (or use from or dockerfile to have reeval build it).`,
      })
    })
    return { ref: image, info, dockerfile: null }
  }
  if (sandbox.from) {
    const ref = harnessImageFor(harness, sandbox.from)
    return { ref, info: await bake(sandbox.from), dockerfile: null }
  }
  if (sandbox.dockerfile) {
    const path = sandbox.dockerfile
    const reevalBase = usesReevalBase(path)
      ? (await reevalImage(harness, root, signal, b)).id
      : null
    const { tag, sha256 } = dockerfileTag(path, harness, reevalBase)
    const dockerfile = { path: projectPath(root, path), sha256 }
    const info = await b.once(tag, async () => {
      const cached = b.refresh === 'force' ? null : await imageInfo(tag, engine)
      if (cached) return cached
      b.log(`Building ${dockerfile.path} as ${tag}`)
      const output = buildLogger(root, tag)
      await b.retry(() =>
        buildDockerfile(path, {
          harness,
          reevalBase,
          name: dockerfile.path,
          signal,
          output,
          force: true,
          pull: b.refresh === 'force',
          engine,
        }),
      )
      return built(tag, engine)
    })
    // Built on this harness's image, so its CLI is already there. Any other base, including
    // another harness's image, gets this harness baked on.
    if (info.labels[LABEL.harness] === harnessLabel(harness)) {
      return { ref: tag, info, dockerfile }
    }
    return { ref: harnessImageFor(harness, tag), info: await bake(tag), dockerfile }
  }
  const ref = imageFor(harness)
  return { ref, info: await reevalImage(harness, root, signal, b), dockerfile: null }
}

/**
 * The image an attempt's container starts from: the sandbox's image for the harness, plus a
 * cached layer with its `install` commands, each built if missing. Each build's log goes to
 * `.reeval/cache/images/` under `root`.
 */
export async function prepareImage(
  sandbox: DockerSandboxDescriptor,
  harness: BakedHarness,
  root: string,
  signal: AbortSignal,
  b: Builds,
): Promise<AttemptImage> {
  const base = await harnessBase(sandbox, harness, root, signal, b)
  const agentCli = base.info.labels[LABEL.agentVersion] ?? null
  const steps = installSteps(sandbox)
  const install = (sandbox.install ?? []).map(stepCommand)
  const digest = sandbox.from ? (base.info.labels[LABEL.fromDigest] ?? null) : null
  const image = {
    agentCli,
    base: base.ref,
    install,
    dockerfile: base.dockerfile,
    ...(sandbox.from ? { from: { ref: sandbox.from, digest } } : {}),
  }
  if (steps.length === 0) return { ref: base.ref, id: base.info.id, ...image }

  const parent = { ref: base.ref, id: base.info.id }
  const ref = installLayerTag(parent, steps)
  const info = await b.once(ref, async () => {
    const cached = await imageInfo(ref, b.engine)
    if (cached) return cached
    b.log(`Installing ${steps.length} command(s) onto ${base.ref} as ${ref}`)
    const output = buildLogger(root, ref)
    // The user's own commands: a failure is theirs, never retried.
    await buildInstallLayer(parent, steps, { signal, output, engine: b.engine })
    return built(ref, b.engine)
  })
  return { ref, id: info.id, ...image }
}
