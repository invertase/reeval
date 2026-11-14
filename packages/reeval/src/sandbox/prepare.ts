import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { setupOf } from '@reeval/agents'
import {
  type BakedHarness,
  buildDockerfile,
  buildImage,
  buildInstallLayer,
  buildPluginLayer,
  contextHash,
  dockerfileBases,
  dockerfileKey,
  dockerfileTag,
  type Engine,
  engineSpec,
  harnessImageFor,
  harnessLabel,
  type ImageInfo,
  imageFor,
  imageInfo,
  imageKey,
  isLocalKey,
  LABEL,
  type Layer,
  localKey,
  type PluginBuildSpec,
  pluginBuildDir,
  pullLayer,
  pushLayer,
  reevalImageKey,
  resolveFrom,
  sourceTreeHash,
  usesReevalBase,
} from '@reeval/sandbox-docker'
import '../debug/docker.ts'
import { buildSteps, pluginBuildId, pluginCall } from '../environment/plugins.ts'
import { stepCommand } from '../environment.ts'
import type {
  AttemptImage,
  DockerSandboxDescriptor,
  HarnessDescriptor,
  PluginBuild,
  PluginSource,
} from '../types.ts'
import { PrepareError } from './provider.ts'
import { bakedKey, installLayer, installSteps, pluginLayer } from './recipe.ts'

/** Whose CLI a harness's image carries. The fake harness runs in its `layout`'s, else Cursor's. */
export const imageHarness = (harness: HarnessDescriptor): BakedHarness =>
  harness.kind === 'fake' ? (harness.layout ?? 'cursor') : harness.kind

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
  /** The registry prefix (`--registry`) a missing image is pulled from before it's built. */
  registry: string | null
  /** Push every image reeval built or pulled to {@link registry}: `reeval image build --push`. */
  push: boolean
  /** Pushes a layer to {@link registry} once per run. */
  pushOnce: (layer: Layer, signal: AbortSignal) => Promise<void>
}

export type Refresh = 'none' | 'check' | 'force'

export function createBuilds(options: Partial<Omit<Builds, 'once' | 'pushOnce'>> = {}): Builds {
  const builds = new Map<string, Promise<ImageInfo>>()
  const pushes = new Map<string, Promise<void>>()
  const log = options.log ?? (() => {})
  const retry = options.retry ?? ((step) => step())
  const engine = options.engine ?? 'docker'
  const registry = options.registry ?? null
  return {
    once: (ref, build) => {
      let done = builds.get(ref)
      if (!done) {
        done = build()
        builds.set(ref, done)
      }
      return done
    },
    retry,
    log,
    refresh: options.refresh ?? 'none',
    engine,
    registry,
    push: !!options.push && registry !== null,
    pushOnce: (layer, signal) => {
      let done = pushes.get(layer.ref)
      if (!done && registry && !onlyHere(layer)) {
        done = retry(() => pushLayer(registry, layer, { engine, signal })).then((remote) =>
          log(`Pushed ${layer.ref} as ${remote}`),
        )
        pushes.set(layer.ref, done)
      }
      return done ?? Promise.resolve()
    },
  }
}

/** A layer only this machine can name, or one built on such a layer: never pulled or pushed. */
const onlyHere = (layer: Layer) => !!layer.local || isLocalKey(layer.key)

/**
 * `layer` from the run's registry, when there is one and it has it: its image, or null to build
 * it. A registry that lacks it or can't be reached only costs the build.
 */
async function pulled(layer: Layer, b: Builds, signal: AbortSignal): Promise<ImageInfo | null> {
  if (!b.registry || b.refresh === 'force' || onlyHere(layer)) return null
  const r = await pullLayer(b.registry, layer, { engine: b.engine, signal })
  if (!r.pulled) {
    b.log(`${r.remote} isn't in the registry (${r.reason}): building ${layer.ref}`)
    return null
  }
  b.log(`Pulled ${layer.ref} from ${r.remote}`)
  return imageInfo(layer.ref, b.engine)
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

/**
 * reeval's image for the harness: pulled or built when it's missing, or when reeval's base context
 * changed.
 */
export const reevalImage = (
  harness: BakedHarness,
  root: string,
  signal: AbortSignal,
  b: Builds,
) => {
  const ref = imageFor(harness)
  const { engine } = b
  const current = (info: ImageInfo | null) => info?.labels[LABEL.context] === contextHash()
  return b.once(ref, async () => {
    const info = await imageInfo(ref, engine)
    if (info && current(info) && b.refresh !== 'force') return info
    const fetched = await pulled({ ref, key: reevalImageKey(harness) }, b, signal)
    if (fetched && current(fetched)) return fetched
    b.log(
      info && !current(info) ? `Rebuilding ${ref}: reeval's base image changed` : `Building ${ref}`,
    )
    const output = buildLogger(root, ref)
    const pull = b.refresh === 'force'
    await b.retry(() =>
      buildImage(b.log, { harness, bootstrap: setupOf(harness), signal, output, pull, engine }),
    )
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
): Promise<Layer & { info: ImageInfo; dockerfile: AttemptImage['dockerfile']; layers: Layer[] }> {
  const { engine } = b
  /**
   * `from` with the harness baked on. Its key is what `from` named when it was built, unless the
   * caller knows a key that pins `from`'s content (a Dockerfile's tag).
   */
  const bake = async (from: string, key?: string): Promise<Layer & { info: ImageInfo }> => {
    const ref = harnessImageFor(harness, from)
    const info = await b.once(ref, async () => {
      const cached = b.refresh === 'force' ? null : await imageInfo(ref, engine)
      let now: Awaited<ReturnType<typeof resolveFrom>> | null = null
      if (cached && b.refresh === 'check') {
        // `reeval image build` refreshes a tag that moved upstream; a pinned digest never moves.
        now = await resolveFrom(from, signal, engine)
        const was = cached.labels[LABEL.fromDigest]
        if ('digest' in now && was && now.digest !== was) {
          b.log(`Rebuilding ${ref}: ${from} moved upstream`)
        } else return cached
      } else if (cached) return cached
      if (b.registry && b.refresh !== 'force') {
        now ??= key ? null : await resolveFrom(from, signal, engine)
        const pin =
          key ?? (now && 'digest' in now && !now.local ? bakedKey(harness, from, now.digest) : null)
        const fetched = pin ? await pulled({ ref, key: pin }, b, signal) : null
        if (fetched) return fetched
      }
      const output = buildLogger(root, ref)
      const pull = b.refresh === 'force'
      await b.retry(() =>
        buildImage(b.log, {
          harness,
          bootstrap: setupOf(harness),
          from,
          signal,
          output,
          pull,
          engine,
          ...(key ? { key } : {}),
        }),
      )
      return built(ref, engine)
    })
    // An empty key label: built on a base only this machine has.
    const own =
      info.labels[LABEL.key] === ''
        ? localKey(ref, info.id)
        : bakedKey(harness, from, info.labels[LABEL.fromDigest] ?? info.id)
    return { ref, info, key: key ?? own }
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
    return { ref: image, key: imageKey(info), info, dockerfile: null, layers: [] }
  }
  if (sandbox.from) {
    const baked = await bake(sandbox.from)
    return { ...baked, dockerfile: null, layers: [baked] }
  }
  if (sandbox.dockerfile) {
    const path = sandbox.dockerfile
    const layers: Layer[] = []
    if (usesReevalBase(path)) {
      await reevalImage(harness, root, signal, b)
      layers.push({ ref: imageFor(harness), key: reevalImageKey(harness) })
    }
    const { tag, sha256 } = dockerfileTag(path, harness)
    const dockerfile = { path: projectPath(root, path), sha256 }
    const info = await b.once(tag, async () => {
      const cached = b.refresh === 'force' ? null : await imageInfo(tag, engine)
      if (cached) return cached
      // What its moving bases name now. A base behind a build arg, one that doesn't resolve or one
      // only this machine has makes it this machine's alone: keyed on its id, with no key label.
      const { bases: refs, opaque } = dockerfileBases(path)
      const bases = await Promise.all(
        refs.map(async (ref) => ({ ref, now: await resolveFrom(ref, signal, engine) })),
      )
      const shared = !opaque && bases.every(({ now }) => 'digest' in now && !now.local)
      const key = shared
        ? dockerfileKey(
            tag,
            bases.map(({ ref, now }) => ({ ref, digest: 'digest' in now ? now.digest : '' })),
          )
        : ''
      const fetched = shared ? await pulled({ ref: tag, key }, b, signal) : null
      if (fetched) return fetched
      b.log(`Building ${dockerfile.path} as ${tag}`)
      const output = buildLogger(root, tag)
      await b.retry(() =>
        buildDockerfile(path, {
          harness,
          name: dockerfile.path,
          signal,
          output,
          force: true,
          pull: b.refresh === 'force',
          engine,
          key,
        }),
      )
      return built(tag, engine)
    })
    const key = info.labels[LABEL.key] || localKey(tag, info.id)
    // Built on this harness's image, so its CLI is already there. Any other base, including
    // another harness's image, gets this harness baked on.
    layers.push({ ref: tag, key })
    if (info.labels[LABEL.harness] === harnessLabel(harness)) {
      return { ref: tag, key, info, dockerfile, layers }
    }
    const baked = await bake(tag, bakedKey(harness, tag, key))
    return { ...baked, dockerfile, layers: [...layers, baked] }
  }
  const base = { ref: imageFor(harness), key: reevalImageKey(harness) }
  const info = await reevalImage(harness, root, signal, b)
  return { ...base, info, dockerfile: null, layers: [base] }
}

/** A plugin build baked into an attempt's image: which build, its layer, and where it left the plugin. */
export type BuiltPlugin = { id: string; tag: string; dir: string; commit: string | null }

/** What a Docker sandbox's `prepare` returns: the attempt's image, and the plugins built into it. */
export type PreparedImage = AttemptImage & { plugins?: BuiltPlugin[] }

/** A plugin build's layer spec, from its source fetched on the host. */
export async function pluginBuildSpec(
  root: string,
  source: PluginSource,
): Promise<PluginBuildSpec> {
  const { pluginSourceDir } = await import('../environment/resolve.ts')
  const src = await pluginSourceDir(root, source)
  const { run, cwd } = buildSteps(source.build as PluginBuild)
  return {
    context: src.context,
    commit: src.commit,
    tree: sourceTreeHash(src.context),
    path: src.path,
    cwd: cwd ?? src.path,
    steps: run.map((r) => ({ run: r })),
  }
}

/**
 * The image an attempt's container starts from: the sandbox's image for the harness, plus a
 * cached layer with its `install` commands, then one cached layer per built plugin, each built if
 * missing. Each build's log goes to `.reeval/cache/images/` under `root`.
 */
export async function prepareImage(
  sandbox: DockerSandboxDescriptor,
  harness: BakedHarness,
  root: string,
  signal: AbortSignal,
  b: Builds,
  plugins: readonly PluginSource[] = [],
): Promise<PreparedImage> {
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
  const local = isLocalKey(base.key)
  let parent = { ref: base.ref, key: base.key, id: base.info.id }
  const layers = [...base.layers]
  if (steps.length) {
    const layer = installLayer(parent, steps, local)
    const { ref } = layer
    const on = parent
    const info = await b.once(ref, async () => {
      // Its tag is its parent's key, which a forced rebuild of the parent keeps.
      const force = b.refresh === 'force'
      const cached = force ? null : await imageInfo(ref, b.engine)
      if (cached) return cached
      const fetched = await pulled(layer, b, signal)
      if (fetched) return fetched
      b.log(`Installing ${steps.length} command(s) onto ${base.ref} as ${ref}`)
      const output = buildLogger(root, ref)
      // The user's own commands: a failure is theirs, never retried.
      await buildInstallLayer(on, steps, { signal, output, engine: b.engine, force })
      return built(ref, b.engine)
    })
    parent = { ref, key: ref, id: info.id }
    layers.push(layer)
  }
  const builtPlugins: BuiltPlugin[] = []
  for (const source of plugins) {
    const spec = await b.retry(() => pluginBuildSpec(root, source))
    const layer = pluginLayer(parent, spec, local)
    const { ref } = layer
    const on = parent
    const name = `the build of ${pluginCall(source, root)}`
    const info = await b.once(ref, async () => {
      const force = b.refresh === 'force'
      const cached = force ? null : await imageInfo(ref, b.engine)
      if (cached) return cached
      const fetched = await pulled(layer, b, signal)
      if (fetched) return fetched
      b.log(`Building ${name} onto ${on.ref} as ${ref}`)
      const output = buildLogger(root, ref)
      // The user's own commands: a failure is theirs, never retried.
      await buildPluginLayer(on, spec, { name, signal, output, engine: b.engine, force })
      return built(ref, b.engine)
    })
    builtPlugins.push({
      id: pluginBuildId(source),
      tag: ref,
      dir: pluginBuildDir(spec),
      commit: spec.commit,
    })
    parent = { ref, key: ref, id: info.id }
    layers.push(layer)
  }
  if (b.push) for (const layer of layers) await b.pushOnce(layer, signal)
  return {
    ref: parent.ref,
    id: parent.id,
    ...image,
    ...(builtPlugins.length ? { plugins: builtPlugins } : {}),
  }
}
