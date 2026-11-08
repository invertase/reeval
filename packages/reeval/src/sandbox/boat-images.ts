// An environment's image built once into a Boat saved snapshot: a build VM created with snapshots
// on runs `prepareImage` against its own Docker over SSH, a container keeps the final image (a
// snapshot keeps only images a container uses), and the VM is saved under a name made from the
// recipe's content key. Another run, or a later one, finds the snapshot by that name.
import { createHash, randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { docker, dockerfileTag, isTransient, type RemoteEngine } from '@reeval/sandbox-docker'
import { pluginBuildId } from '../environment/plugins.ts'
import type {
  BoatSandboxDescriptor,
  DockerSandboxDescriptor,
  HarnessDescriptor,
  PluginSource,
} from '../types.ts'
import {
  type BoatClient,
  boatError,
  deleteSandbox,
  deleteUntilGone,
  startVm,
  type VmService,
} from './boat.ts'
import { sandboxLabels } from './labels.ts'
import { createBuilds, imageHarness, pluginBuildSpec, prepareImage } from './prepare.ts'
import { type PrepareContext, PrepareError } from './provider.ts'
import { type ImageRecipe, imageRecipeKey, type ResolveDigest, registryResolver } from './recipe.ts'

import { InfraError } from './types.ts'

/** What reeval itself puts in a VM image beside the recipe's; a change rebuilds every snapshot. */
const VM_IMAGE_REVISION = 1

/** A Boat sandbox with the image recipe its attempts run in. */
export type BoatImageTarget = BoatSandboxDescriptor & Partial<ImageRecipe>

/** What an attempt starts from: the saved snapshot, and the image in it. */
export type BoatImage = {
  snapshot: string
  /** The recipe's content key, which names the snapshot. */
  key: string
  /** False when a base couldn't be resolved, so the key names its tag, not its content. */
  pinned: boolean
  /** The image in the VM's Docker that attempts run in: {@link vmImageRef} of the key. */
  imageRef: string
  /** Its id and harness CLI version, known when this run built it. */
  imageId: string | null
  agentCli: string | null
  sizeBytes: number | null
  /** This run built it, rather than finding it saved. */
  built: boolean
}

/** The tag a VM image has in its snapshot, so any run can name it from the key alone. */
export const vmImageRef = (key: string) => `reeval-vm-image:${key.slice(0, 12)}`

/** The saved snapshot a recipe key is kept under. */
export const snapshotName = (prefix: string, key: string) => `${prefix}-img-${key.slice(0, 12)}`

/**
 * How long a build VM lives, past which Boat removes one a killed run left: its name is the
 * recipe's and no run's, so a run's cleanup doesn't find it.
 */
const BUILD_TTL_S = 45 * 60
/** How long a save may take before it's given up. */
const SAVE_TIMEOUT_MS = 10 * 60_000
/** How long to wait on a snapshot another run is saving. */
const SETTLE_TIMEOUT_MS = 15 * 60_000

type Saved = { name: string; status: string; error?: string; sizeBytes?: number }

/** The saved-snapshot calls reeval makes, beside {@link BoatClient}'s. */
export type BoatSnapshotClient = BoatClient & {
  getSavedSnapshot(p: { name: string }): Promise<{ snapshot: Saved }>
  saveSavedSnapshot(p: {
    savedSnapshotSaveRequest: { sandboxId: string; name: string }
  }): Promise<{ snapshot: Saved }>
  deleteSavedSnapshot(p: { name: string }): Promise<unknown>
}

const status = (error: unknown) => (error as { response?: Response }).response?.status

const refusal = (message: string, ref: string | null, usage = true) =>
  new PrepareError({
    class: 'config',
    stage: 'boat-image',
    ref,
    cause: null,
    log: null,
    usage,
    message,
  })

/**
 * The content key of `recipe` on `harness` with `plugins`, as a VM image: {@link imageRecipeKey}'s
 * when every base resolves. An `image` is keyed on what its registry names now, since the build VM
 * pulls it by name. A base that doesn't resolve, or one behind a build argument, is keyed on the
 * recipe as written and a Dockerfile's build context, so a moved tag isn't rebuilt until one of
 * those changes.
 */
export async function vmImageKey(
  recipe: ImageRecipe,
  harness: HarnessDescriptor,
  o: {
    root: string
    plugins?: readonly PluginSource[]
    resolve?: ResolveDigest
    signal?: AbortSignal
  },
): Promise<{ key: string; pinned: boolean }> {
  const resolve = o.resolve ?? registryResolver()
  const plugins = o.plugins ?? []
  const specs = await Promise.all(plugins.map((p) => pluginBuildSpec(o.root, p)))
  const baked = imageHarness(harness)
  const r = await imageRecipeKey(recipe, baked, { resolve, plugins: specs, signal: o.signal })
  let base: string
  let pinned = true
  if ('key' in r) base = r.key
  else if (recipe.image) {
    const now = await resolve(recipe.image, o.signal)
    if ('error' in now) {
      if (now.error.startsWith("couldn't reach ") || isTransient(now.error)) {
        throw new PrepareError({
          class: 'transient',
          stage: 'boat-image',
          ref: recipe.image,
          cause: null,
          log: null,
          message: `boat() couldn't look up image ${recipe.image} in its registry: ${now.error}`,
        })
      }
      throw refusal(
        `boat() pulls image ${recipe.image} from its registry, which doesn't answer for it: ${now.error}. Push it to a registry the build VM can pull from, or use dockerfile to build it.`,
        recipe.image,
      )
    }
    base = JSON.stringify({
      image: recipe.image,
      digest: now.digest,
      harness: baked,
      install: recipe.install ?? [],
      plugins: plugins.map(pluginBuildId),
    })
  } else {
    pinned = false
    base = JSON.stringify({
      recipe,
      harness: baked,
      plugins: plugins.map(pluginBuildId),
      unresolved: r.unresolved.ref,
      ...(recipe.dockerfile && { context: dockerfileTag(recipe.dockerfile, baked).sha256 }),
    })
  }
  const key = createHash('sha256')
    .update(['boat', VM_IMAGE_REVISION, base].join('\0'))
    .digest('hex')
  return { key, pinned }
}

async function savedSnapshot(api: BoatSnapshotClient, name: string): Promise<Saved | null> {
  try {
    return (await api.getSavedSnapshot({ name })).snapshot
  } catch (error) {
    if (status(error) === 404) return null
    throw new InfraError(`Boat didn't report snapshot ${name}: ${await boatError(error)}`)
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      if (signal.aborted) reject(signal.reason)
      else resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })

/** The snapshot named `name` once it isn't `saving`, or null when there's none. */
async function settled(
  api: BoatSnapshotClient,
  name: string,
  signal: AbortSignal,
  o: { timeoutMs: number; pollMs: number },
): Promise<Saved | null> {
  const deadline = Date.now() + o.timeoutMs
  for (;;) {
    const saved = await savedSnapshot(api, name)
    if (saved?.status !== 'saving') return saved
    if (Date.now() > deadline) {
      throw new InfraError(
        `Boat snapshot ${name} was still saving after ${Math.round(o.timeoutMs / 1000)}s`,
      )
    }
    await sleep(o.pollMs, signal)
  }
}

/** Runs the docker CLI on the build VM; a failure is a {@link PrepareError} naming `doing`. */
async function vmDocker(
  engine: RemoteEngine,
  args: string[],
  doing: string,
  signal: AbortSignal,
  input?: string,
): Promise<string> {
  const r = await docker(args, { engine, signal, ...(input !== undefined && { input }) })
  if (r.exitCode === 0) return r.stdout.toString('utf8').trim()
  const cause = /no space left on device/i.test(r.stderr) ? 'enospc' : null
  throw new PrepareError({
    class: cause
      ? 'resource'
      : r.exitCode === 255 || isTransient(r.stderr)
        ? 'transient'
        : 'config',
    stage: 'boat-image',
    ref: null,
    cause,
    log: r.stderr,
    message: `${doing} on ${engine.description} failed: ${r.stderr.trim().split('\n').at(-1) ?? `exit ${r.exitCode}`}`,
  })
}

/** Timings a test shortens. */
export type BoatImageTimings = { pollMs?: number; saveTimeoutMs?: number; settleTimeoutMs?: number }

/**
 * The saved snapshot `sandbox`'s recipe runs in, built when there's none: on a hit, what it holds;
 * on a miss, a build VM of the sandbox's type builds the image, keeps it in a container and is
 * saved, then deleted. A snapshot another run is saving is waited on; a failed one is deleted
 * and built again.
 */
export async function boatImage(
  service: VmService,
  api: BoatSnapshotClient,
  sandbox: BoatImageTarget,
  recipe: ImageRecipe,
  harness: HarnessDescriptor,
  ctx: PrepareContext,
  o: {
    plugins?: readonly PluginSource[]
    resolve?: ResolveDigest
    timings?: BoatImageTimings
  } = {},
): Promise<BoatImage> {
  const { signal } = ctx
  const pollMs = o.timings?.pollMs ?? 5_000
  const plugins = o.plugins ?? []
  const { key, pinned } = await vmImageKey(recipe, harness, {
    root: ctx.root,
    plugins,
    signal,
    ...(o.resolve && { resolve: o.resolve }),
  })
  const name = snapshotName(sandbox.prefix, key)
  const found = await settled(api, name, signal, {
    timeoutMs: o.timings?.settleTimeoutMs ?? SETTLE_TIMEOUT_MS,
    pollMs,
  })
  const imageRef = vmImageRef(key)
  const saved = (snapshot: Saved): BoatImage => {
    ctx.log(`Using Boat snapshot ${name}`)
    return {
      snapshot: name,
      key,
      pinned,
      imageRef,
      imageId: null,
      agentCli: null,
      sizeBytes: snapshot.sizeBytes ?? null,
      built: false,
    }
  }
  if (found?.status === 'ready') return saved(found)
  if (found) {
    ctx.log(
      `Building Boat snapshot ${name} again: it failed to save${found.error ? ` (${found.error})` : ''}`,
    )
    await deleteSnapshot(api, name)
  }
  const type = sandbox.type ?? 'small'
  const vm = await startVm(service, api, {
    name: `${sandbox.prefix}-build-${key.slice(0, 12)}-${randomBytes(3).toString('hex')}`,
    type,
    size: type,
    ttlSeconds: BUILD_TTL_S,
    snapshots: true,
    labels: { ...sandboxLabels(), 'reeval-prefix': sandbox.prefix },
    signal,
  })
  const started = Date.now()
  try {
    const engine: RemoteEngine = {
      kind: 'ssh',
      target: {
        host: vm.info.host,
        port: vm.info.port,
        user: vm.info.user,
        identityFile: vm.info.identityFile,
        knownHostsFile: vm.info.knownHostsFile,
        hostKeyAlias: vm.id,
        controlPath: join(vm.dir, 'cm'),
      },
      description: `boat build VM ${vm.id}`,
    }
    ctx.log(`Building Boat snapshot ${name} on ${engine.description}`)
    const builds = createBuilds({ retry: ctx.retry, log: ctx.log, engine })
    if (recipe.image) {
      await ctx.retry(() =>
        vmDocker(engine, ['pull', recipe.image as string], `pulling ${recipe.image}`, signal),
      )
    }
    const prepared = await prepareImage(
      { kind: 'docker', ...recipe } as DockerSandboxDescriptor,
      imageHarness(harness),
      ctx.root,
      signal,
      builds,
      plugins,
    )
    // Boat pulls a registry image again at every restore, so the image is built in the VM, where
    // a one-line build on top of a pulled `image` is enough to have it saved.
    if (prepared.ref === recipe.image) {
      await vmDocker(
        engine,
        ['build', '--quiet', '--tag', imageRef, '-'],
        `building ${imageRef}`,
        signal,
        `FROM ${prepared.ref}\nLABEL ${KEY_LABEL}=${key}\n`,
      )
    } else {
      await vmDocker(engine, ['tag', prepared.ref, imageRef], `tagging ${imageRef}`, signal)
    }
    const imageId = await vmDocker(
      engine,
      ['image', 'inspect', '--format', '{{.Id}}', imageRef],
      `inspecting ${imageRef}`,
      signal,
    )
    const keep = keepContainer(key)
    await vmDocker(
      engine,
      [
        'create',
        '--name',
        keep,
        '--label',
        `${KEY_LABEL}=${key}`,
        '--entrypoint',
        'true',
        imageRef,
      ],
      'keeping the image in a container',
      signal,
    )
    // Starts the image once, so a restored VM's first container starts warm; one with no `true`
    // only misses that.
    await docker(['run', '--rm', '--entrypoint', 'true', imageRef], { engine, signal })
    await vmDocker(
      engine,
      ['builder', 'prune', '--all', '--force'],
      'pruning the build cache',
      signal,
    )
    await vmDocker(engine, ['image', 'prune', '--force'], 'pruning unused images', signal)
    const result = await save(api, vm.id, name, signal, {
      pollMs,
      timeoutMs: o.timings?.saveTimeoutMs ?? SAVE_TIMEOUT_MS,
    })
    // Another run saved the same recipe first: its snapshot holds the same image.
    if ('taken' in result) return saved(result.taken)
    ctx.log(`Saved Boat snapshot ${name} in ${Math.round((Date.now() - started) / 1000)}s`)
    return {
      snapshot: name,
      key,
      pinned,
      imageRef,
      imageId,
      agentCli: prepared.agentCli,
      sizeBytes: result.saved.sizeBytes ?? null,
      built: true,
    }
  } finally {
    if (
      !(await deleteSandbox(api, vm.id).then(
        () => true,
        () => false,
      ))
    ) {
      await deleteUntilGone(api, vm.id, { signal }).catch(() => {})
    }
    await rm(vm.dir, { recursive: true, force: true })
  }
}

/** The label on a VM image and its keep container: the recipe's content key. */
const KEY_LABEL = 'reeval.vm-image.key'

/** The container that keeps a snapshot's image, which Boat saves only while a container uses it. */
const keepContainer = (key: string) => `reeval-keep-${key.slice(0, 12)}`

/** Deletes the saved snapshot `name`; one that's already gone is fine. */
async function deleteSnapshot(api: BoatSnapshotClient, name: string): Promise<void> {
  try {
    await api.deleteSavedSnapshot({ name })
  } catch (error) {
    if (status(error) === 404) return
    throw new InfraError(`Boat didn't delete snapshot ${name}: ${await boatError(error)}`)
  }
}

/**
 * Saves the build VM as `name` and waits until it's ready; a failed save is deleted. `taken` when
 * another run's snapshot already has the name and is ready.
 */
async function save(
  api: BoatSnapshotClient,
  sandboxId: string,
  name: string,
  signal: AbortSignal,
  o: { pollMs: number; timeoutMs: number },
): Promise<{ saved: Saved } | { taken: Saved }> {
  try {
    await api.saveSavedSnapshot({ savedSnapshotSaveRequest: { sandboxId, name } })
  } catch (error) {
    const why = await boatError(error)
    if (status(error) === 409) {
      const other = await settled(api, name, signal, o)
      if (other?.status === 'ready') return { taken: other }
      if (other) {
        await deleteSnapshot(api, name)
        throw new PrepareError({
          class: 'transient',
          stage: 'boat-image',
          ref: name,
          cause: null,
          log: null,
          message: `Boat snapshot ${name}, which another run was saving, failed${other.error ? `: ${other.error}` : ''}`,
        })
      }
    }
    if (status(error) === 403 || status(error) === 409) {
      throw refusal(`Boat won't save snapshot ${name}: ${why}`, name, false)
    }
    throw new InfraError(`Boat didn't save snapshot ${name}: ${why}`)
  }
  const saved = await settled(api, name, signal, o).catch(async (error: unknown) => {
    await deleteSnapshot(api, name).catch(() => {})
    throw error
  })
  if (saved?.status === 'ready') return { saved }
  await deleteSnapshot(api, name).catch(() => {})
  throw new InfraError(
    `Boat snapshot ${name} ${saved ? `failed to save${saved.error ? `: ${saved.error}` : ''}` : 'disappeared while saving'}`,
  )
}
