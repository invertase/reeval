import {
  type BakedHarness,
  dockerfileBases,
  dockerfileFinalBase,
  dockerfileKey,
  dockerfileTag,
  fromImageKey,
  harnessImageFor,
  type InstallStep,
  imageFor,
  installLayerTag,
  type Layer,
  type PluginBuildSpec,
  pluginLayerTag,
  REEVAL_BASE_ARG,
  type RegistryCredential,
  reevalImageKey,
  registryDigest,
  usesReevalBase,
} from '@reeval/sandbox-docker'
import { parseDuration } from '../config.ts'
import type { DockerSandboxDescriptor } from '../types.ts'

/** The sandbox options that decide what's in an attempt's image. */
export type ImageRecipe = Pick<DockerSandboxDescriptor, 'image' | 'from' | 'dockerfile' | 'install'>

/** What a registry reference names now: its top-level manifest's digest, or why it doesn't. */
export type ResolveDigest = (
  ref: string,
  signal?: AbortSignal,
) => Promise<{ digest: string } | { error: string }>

/**
 * An image recipe's content key: `key` is its last layer's, and `layers` the chain from the image
 * the harness runs in up, each as `prepareImage` names and keys it. `unresolved` when it can't be
 * named from this host alone: a base the registry doesn't answer for, or a Dockerfile whose `FROM`
 * names a build argument.
 */
export type RecipeKey =
  | { key: string; layers: Layer[] }
  | { unresolved: { ref: string; reason: string } }

/** The sandbox's `install` commands, with their timeouts in ms. */
export const installSteps = (sandbox: Pick<DockerSandboxDescriptor, 'install'>): InstallStep[] =>
  (sandbox.install ?? []).map((step) =>
    typeof step === 'string'
      ? { run: step }
      : {
          run: step.run,
          ...(step.timeout !== undefined ? { timeoutMs: parseDuration(step.timeout) } : {}),
        },
  )

/** The key of `from` with the harness baked on, when `pin` names what `from` is. */
export const bakedKey = (harness: BakedHarness, from: string, pin: string) =>
  fromImageKey(harnessImageFor(harness, from), pin)

/** The `install` layer on `parent`: its tag is its key. */
export const installLayer = (
  parent: Pick<Layer, 'key'>,
  steps: InstallStep[],
  local: boolean,
): Layer => {
  const ref = installLayerTag(parent, steps)
  return { ref, key: ref, local }
}

/** A plugin build's layer on `parent`: its tag is its key. */
export const pluginLayer = (
  parent: Pick<Layer, 'key'>,
  spec: PluginBuildSpec,
  local: boolean,
): Layer => {
  const ref = pluginLayerTag(parent, spec)
  return { ref, key: ref, local }
}

/** Whether a Dockerfile's image needs the harness baked on: its last stage isn't on its image. */
export const dockerfileBakes = (path: string, harness: BakedHarness) => {
  const base = dockerfileFinalBase(path)
  return (
    !new RegExp(`^\\$\\{?${REEVAL_BASE_ARG}\\}?$`).test(base ?? '') && base !== imageFor(harness)
  )
}

/** Resolves through the registry HTTP API from the host, anonymously or with `credential`'s login. */
export const registryResolver =
  (credential?: (host: string) => RegistryCredential | undefined): ResolveDigest =>
  (ref, signal) =>
    registryDigest(ref, { signal, credential })

/**
 * The content key of the image an attempt on `harness` starts from, from the recipe alone and
 * what its bases name in their registries now, with no container engine: the key `prepareImage`
 * gives the same recipe's last layer when its bases resolve to the same digests. `image` as is
 * keys on its registry digest, where Docker keys on the local image's id. `plugins` are the
 * recipe's plugin builds' specs, fetched on the host.
 */
export async function imageRecipeKey(
  recipe: ImageRecipe,
  harness: BakedHarness,
  options: {
    resolve?: ResolveDigest | undefined
    plugins?: readonly PluginBuildSpec[] | undefined
    signal?: AbortSignal | undefined
  } = {},
): Promise<RecipeKey> {
  const resolve = options.resolve ?? registryResolver()
  const digest = async (ref: string) => resolve(ref, options.signal)
  const layers: Layer[] = []
  if (recipe.image) {
    const now = await digest(recipe.image)
    if ('error' in now) return { unresolved: { ref: recipe.image, reason: now.error } }
    layers.push({ ref: recipe.image, key: fromImageKey(recipe.image, now.digest) })
  } else if (recipe.from) {
    const now = await digest(recipe.from)
    if ('error' in now) return { unresolved: { ref: recipe.from, reason: now.error } }
    layers.push({
      ref: harnessImageFor(harness, recipe.from),
      key: bakedKey(harness, recipe.from, now.digest),
    })
  } else if (recipe.dockerfile) {
    const path = recipe.dockerfile
    if (usesReevalBase(path)) layers.push({ ref: imageFor(harness), key: reevalImageKey(harness) })
    const { bases, opaque } = dockerfileBases(path)
    if (opaque) {
      return { unresolved: { ref: path, reason: 'a FROM names a build argument' } }
    }
    const named: { ref: string; digest: string }[] = []
    for (const ref of bases) {
      const now = await digest(ref)
      if ('error' in now) return { unresolved: { ref, reason: now.error } }
      named.push({ ref, digest: now.digest })
    }
    const { tag } = dockerfileTag(path, harness)
    const key = dockerfileKey(tag, named)
    layers.push({ ref: tag, key })
    if (dockerfileBakes(path, harness)) {
      layers.push({ ref: harnessImageFor(harness, tag), key: bakedKey(harness, tag, key) })
    }
  } else {
    layers.push({ ref: imageFor(harness), key: reevalImageKey(harness) })
  }
  const steps = installSteps(recipe)
  if (steps.length) layers.push(installLayer(layers.at(-1) as Layer, steps, false))
  for (const spec of options.plugins ?? []) {
    layers.push(pluginLayer(layers.at(-1) as Layer, spec, false))
  }
  return { key: (layers.at(-1) as Layer).key, layers }
}
