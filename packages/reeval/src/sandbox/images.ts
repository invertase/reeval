// `reeval image build`: every image the planned attempts' Docker sandboxes need, built or listed,
// and the images their `tart()` sandboxes clone, pulled.
import {
  type BakedHarness,
  contextHash,
  dockerfileBases,
  dockerfileTag,
  type Engine,
  engineSpec,
  fromImageKey,
  harnessImageFor,
  type ImageInfo,
  imageFor,
  imageInfo,
  imageKey,
  installLayerTag,
  isTransient,
  LABEL,
  pluginBuildKey,
  pluginLayerTag,
  REEVAL_BASE_ARG,
  reevalImageKey,
  resolveFrom,
} from '@reeval/sandbox-docker'
import type { PlannedItem } from '../engine/node.ts'
import { buildSteps, pluginBuildId, pluginBuildsLabel, pluginCall } from '../environment/plugins.ts'
import { sandboxId, sandboxProvider } from '../options.ts'
import type {
  AttemptImage,
  DockerSandboxDescriptor,
  HarnessDescriptor,
  PlannedEgress,
  PluginBuild,
  PluginSource,
  RunContext,
  SandboxDescriptor,
  TartSandboxDescriptor,
  VmImage,
} from '../types.ts'
import { prepareAll } from './preflight.ts'
import {
  imageHarness,
  installSteps,
  pluginBuildSpec,
  projectPath,
  usesReevalBase,
} from './prepare.ts'
import type { PrepareFailure } from './provider.ts'
import {
  attemptImage,
  bakedImage,
  classifyTart,
  createProviders,
  dockerKey,
  vmImage,
} from './providers.ts'
import { bakedTartImage, type TartBake, tartBake, tartBakeKey } from './tart-bake.ts'
import type { MissingImage } from './tart-images.ts'

/**
 * One image to make: a Docker sandbox for one harness's CLI. `id` is the sandbox's cell id, the
 * harness, `+ install`, and a number where that's still ambiguous.
 */
export type ImageTarget = {
  id: string
  harness: BakedHarness
  sandbox: DockerSandboxDescriptor
  /** The plugins with a `build`, each a layer on top. */
  plugins: readonly PluginSource[]
  evals: number
}

export type ImageUse = {
  /** The eval it plans for: an eval with cases is one. */
  id: string
  harness: HarnessDescriptor
  sandbox: SandboxDescriptor
  plugins?: readonly PluginSource[]
  /** Its environment's name and the egress it runs under, when the evals planned it. */
  environment?: string
  egress?: PlannedEgress
}

/**
 * What `reeval image build` builds and `reeval doctor` checks: the harness and sandbox of each
 * attempt the evals plan (collected as `--dry-run` does), or the config's harnesses on its sandbox
 * when they plan none.
 */
export async function plannedImageUses(
  run: Pick<
    RunContext,
    'runId' | 'stagingDir' | 'config' | 'runs' | 'tags' | 'concurrency' | 'profile'
  >,
  filters: string[] = [],
  unmatched?: (parts: string[]) => Error,
): Promise<ImageUse[]> {
  const { runEngine } = await import('../engine/node.ts')
  let planned: PlannedItem[] = []
  await runEngine({
    run: JSON.parse(JSON.stringify(run)),
    filters,
    onPlan: async (collected) => {
      if (unmatched && collected.unmatched.length) throw unmatched(collected.unmatched)
      planned = collected.planned.filter((p) => !p.attempt.plan.skip)
      return false
    },
  })
  return planned.length
    ? planned.map((p) => ({
        id: p.attempt.family?.id ?? p.id,
        harness: p.attempt.harness,
        sandbox: p.attempt.sandbox,
        plugins: p.attempt.pluginBuilds ?? [],
        environment: p.attempt.cell.environment,
        egress: p.attempt.egress,
      }))
    : run.config.harness.map((harness) => ({ id: '', harness, sandbox: run.config.sandbox }))
}

/**
 * The distinct Docker sandbox, harness and plugin build sets, in first-use order, with how many
 * evals use each.
 */
export function imageTargets(uses: ImageUse[]) {
  const targets = new Map<string, ImageTarget & { seen: Set<string> }>()
  for (const { id, sandbox, plugins = [], ...use } of uses) {
    if (sandbox.kind !== 'docker') continue
    const harness = imageHarness(use.harness)
    // What's in the image, not the limits or user the container runs with.
    const { engine, image, from, dockerfile, install } = sandbox
    const key = JSON.stringify({
      harness,
      engine,
      image: { image, from, dockerfile, install },
      plugins: plugins.map(pluginBuildId),
    })
    const target = targets.get(key) ?? {
      id: `${sandboxId(sandbox)} · ${harness}`,
      harness,
      sandbox,
      plugins,
      evals: 0,
      seen: new Set(),
    }
    if (!target.seen.has(id)) {
      target.seen.add(id)
      target.evals++
    }
    targets.set(key, target)
  }
  // Cell ids ignore install and plugin builds, so tell sandboxes apart by them, then by number.
  const labels = new Map<string, number>()
  return [...targets.values()].map(({ seen: _, ...t }) => {
    const label = `${t.id}${t.sandbox.install?.length ? ' + install' : ''}${pluginBuildsLabel(t.plugins)}`
    const n = (labels.get(label) ?? 0) + 1
    labels.set(label, n)
    return { ...t, id: n === 1 ? label : `${label} (${n})` }
  })
}

/** How a step of making an image would go, checked without building or pulling. */
export type StageStatus = 'ready' | 'build' | 'stale' | 'missing' | 'unknown'

/** `action` says how the step works; `status` and `detail`, how it stands on this machine. */
export type Stage = {
  what: string
  ref: string
  action: string
  status: StageStatus
  detail: string
}

const short = (digest: string) => digest.replace(/^sha256:/, '').slice(0, 12)

/** An image inspect's answer: the image or null, or the error of a Docker that couldn't say. */
type Look = { info: ImageInfo | null; error?: string }

const look = (ref: string, engine?: Engine): Promise<Look> =>
  imageInfo(ref, engine).then(
    (info) => ({ info }),
    (error: Error) => ({ info: null, error: error.message }),
  )

/**
 * `from`'s image, checked against what the tag names now (a registry lookup, no pull), and its
 * content key: what the built image was built on, or else what a build would be.
 */
async function fromStatus(
  from: string,
  ref: string,
  engine?: Engine,
): Promise<Pick<Stage, 'status' | 'detail'> & { key: string | null }> {
  const [cached, now] = await Promise.all([look(ref, engine), resolveFrom(from, undefined, engine)])
  if (cached.error) return { status: 'unknown', detail: cached.error, key: null }
  const key = cached.info
    ? fromImageKey(ref, cached.info.labels[LABEL.fromDigest] ?? cached.info.id)
    : 'digest' in now
      ? fromImageKey(ref, now.digest)
      : null
  return { ...fromStanding(from, cached.info, now), key }
}

function fromStanding(
  from: string,
  cached: ImageInfo | null,
  now: Awaited<ReturnType<typeof resolveFrom>>,
): Pick<Stage, 'status' | 'detail'> {
  if (!cached) {
    if (!('error' in now)) return { status: 'build', detail: `on ${from} (${short(now.digest)})` }
    // A registry that's down or rate-limiting says nothing about whether the tag exists.
    return isTransient(now.error)
      ? { status: 'build', detail: `${from} couldn't be checked: ${now.error}` }
      : { status: 'missing', detail: `doesn't resolve: ${now.error}` }
  }
  const was = cached.labels[LABEL.fromDigest]
  if ('error' in now) return { status: 'ready', detail: `built; ${from} couldn't be checked` }
  if (was && was !== now.digest) {
    return {
      status: 'stale',
      detail: `${from} moved upstream (${short(was)} → ${short(now.digest)}): reeval image build rebuilds it`,
    }
  }
  return { status: 'ready', detail: `built on ${short(now.digest)}` }
}

/**
 * How each target's image is made, in build order, and how each step stands, building nothing. A
 * step whose image Docker couldn't say is there is `unknown`, with Docker's error.
 */
export async function imageStages(target: ImageTarget, root: string): Promise<Stage[]> {
  const { sandbox, harness } = target
  const { engine } = sandbox
  const stages: Stage[] = []
  type Probe = { info: ImageInfo | null; status: StageStatus; detail: string }
  const exists = async (ref: string): Promise<Probe> => {
    const { info, error } = await look(ref, engine)
    if (error) return { info, status: 'unknown', detail: error }
    return {
      info,
      status: info ? 'ready' : 'build',
      detail: info ? `built (${short(info.id)})` : 'not built yet',
    }
  }
  const reevalBase = async (): Promise<Probe> => {
    const { info, error } = await look(imageFor(harness), engine)
    if (error) return { info, status: 'unknown', detail: error }
    if (!info) return { info, status: 'build', detail: 'not built yet' }
    return info.labels[LABEL.context] === contextHash()
      ? { info, status: 'ready', detail: `built (${short(info.id)})` }
      : {
          info,
          status: 'stale',
          detail: "reeval's base changed: rebuilt before the run",
        }
  }
  // The content key of the image the next layer goes on, when it's known before anything's built.
  let parent: string | null = null
  // Set when Docker couldn't answer for the image the install layer goes on.
  let unanswered: string | null = null
  if (sandbox.image) {
    const found = await look(sandbox.image, engine)
    parent = found.info ? imageKey(found.info) : null
    unanswered = found.error ?? null
    stages.push({
      what: 'image',
      ref: sandbox.image,
      action: 'used as is',
      ...(found.error
        ? { status: 'unknown', detail: found.error }
        : found.info
          ? { status: 'ready', detail: `found (${short(found.info.id)})` }
          : { status: 'missing', detail: 'not found: pull or build it yourself' }),
    })
  } else if (sandbox.from) {
    const ref = harnessImageFor(harness, sandbox.from)
    const { key, ...status } = await fromStatus(sandbox.from, ref, engine)
    parent = key
    if (status.status === 'unknown') unanswered = status.detail
    stages.push({
      what: `from ${sandbox.from}`,
      ref,
      action:
        'Node, git and the harness bootstrap on top; reeval image build refreshes a moved tag',
      ...status,
    })
  } else if (sandbox.dockerfile) {
    const onReeval = usesReevalBase(sandbox.dockerfile)
    const base = onReeval ? await reevalBase() : null
    const { tag } = dockerfileTag(sandbox.dockerfile, harness)
    const built = await exists(tag)
    // Its key, from the built image, or else the tag when no base of it can move before the build.
    const key =
      built.info?.labels[LABEL.key] ?? (dockerfileBases(sandbox.dockerfile).length ? null : tag)
    stages.push({
      what: `dockerfile ${projectPath(root, sandbox.dockerfile)}`,
      ref: tag,
      action: `${engineSpec(engine).bin} build (layer cache), tagged by content hash`,
      status: built.status,
      detail: built.detail,
    })
    if (onReeval) {
      parent = key
      if (built.status === 'unknown') unanswered = built.detail
      stages.push({
        what: 'harness',
        ref: tag,
        action: `inherited: FROM \${${REEVAL_BASE_ARG}}, which is ${imageFor(harness)}`,
        status: base?.status ?? 'build',
        detail:
          base?.status === 'unknown'
            ? base.detail
            : `${imageFor(harness)} ${base?.detail ?? ''}`.trim(),
      })
    } else {
      const ref = harnessImageFor(harness, tag)
      const baked = await exists(ref)
      parent = key ? fromImageKey(ref, key) : null
      if (baked.status === 'unknown') unanswered = baked.detail
      stages.push({
        what: 'harness',
        ref,
        action: 'Node, git and the harness bootstrap on top',
        status: baked.status,
        detail: baked.detail,
      })
    }
  } else {
    const base = await reevalBase()
    parent = reevalImageKey(harness)
    if (base.status === 'unknown') unanswered = base.detail
    stages.push({
      what: 'base',
      ref: imageFor(harness),
      action: "reeval's image: built when missing or when its base changed",
      status: base.status,
      detail: base.detail,
    })
  }
  const pending = (): Probe =>
    unanswered
      ? { info: null, status: 'unknown', detail: unanswered }
      : { info: null, status: 'build', detail: 'not built yet' }
  const steps = installSteps(sandbox)
  if (steps.length) {
    // The tag hashes its base's content key, unknown only for a base that isn't there yet.
    const ref = parent ? installLayerTag({ key: parent }, steps) : null
    const layer = ref ? await exists(ref) : pending()
    parent = ref
    if (layer.status === 'unknown') unanswered ??= layer.detail
    stages.push({
      what: `install ${steps.length} command${steps.length === 1 ? '' : 's'}`,
      ref: ref ?? 'reeval-install:<base key + commands>',
      action: 'build unless cached',
      status: layer.status,
      detail: layer.detail,
    })
  }
  for (const source of target.plugins) {
    const { run, cwd } = buildSteps(source.build as PluginBuild)
    const action = `build unless cached: ${run.join(' && ')}${cwd === null ? '' : ` (from ${cwd})`}`
    const what = `build ${pluginCall(source, root)}`
    // A git or npm source is fetched to hash it, which only a build does.
    if (source.source !== 'local') {
      parent = null
      stages.push({
        what,
        ref: 'reeval-plugin:<base key>-<commit + tree + build>',
        action,
        status: 'unknown',
        detail: `${pluginCall(source, root)} is fetched when reeval image build or a run builds it`,
      })
      continue
    }
    const spec = await pluginBuildSpec(root, source)
    const ref = parent ? pluginLayerTag({ key: parent }, spec) : null
    const layer = ref ? await exists(ref) : pending()
    parent = ref
    if (layer.status === 'unknown') unanswered ??= layer.detail
    stages.push({
      what,
      ref: ref ?? `reeval-plugin:<base key>-${pluginBuildKey(spec).slice(0, 16)}`,
      action,
      status: layer.status,
      detail: layer.detail,
    })
  }
  return stages
}

/** reeval's harness images the targets need: used directly, or as a Dockerfile's `REEVAL_BASE`. */
export const reevalImages = (targets: ImageTarget[]): BakedHarness[] => [
  ...new Set(
    targets
      .filter(
        ({ sandbox: s }) =>
          (!s.image && !s.from && !s.dockerfile) || (s.dockerfile && usesReevalBase(s.dockerfile)),
      )
      .map((t) => t.harness),
  ),
]

const WORST: StageStatus[] = ['missing', 'unknown', 'stale', 'build', 'ready']
const MARKS: Record<StageStatus, string> = {
  ready: '✓',
  build: '+',
  stale: '~',
  missing: '✗',
  unknown: '?',
}
const WORDS: Record<StageStatus, string> = {
  ready: 'ready',
  build: 'to build',
  stale: 'stale',
  missing: 'missing',
  unknown: 'unchecked',
}

/** A target's standing: its worst step. */
export const targetStatus = (stages: Stage[]) =>
  WORST.find((w) => stages.some((s) => s.status === w)) ?? 'ready'

/** `reeval image build --dry-run`: one block per sandbox, each step with how it stands. */
export async function imagePlanLines(targets: ImageTarget[], root: string): Promise<string[]> {
  const lines = [
    `images  ${targets.length} sandbox image${targets.length === 1 ? '' : 's'} (nothing built: --dry-run)`,
  ]
  for (const target of targets) {
    const uses = target.evals ? ` · ${target.evals} eval${target.evals === 1 ? '' : 's'}` : ''
    lines.push(`${target.id}${uses}`)
    const stages = await imageStages(target, root)
    const width = Math.max(...stages.map((s) => s.what.length))
    for (const s of stages) {
      lines.push(
        `  ${MARKS[s.status]} ${s.what.padEnd(width)}  ${s.ref}  (${WORDS[s.status]}: ${s.detail})`,
      )
    }
  }
  return lines
}

/** `reeval run --dry-run`: one line per sandbox the run would prepare. */
export async function imageStatusLines(targets: ImageTarget[], root: string): Promise<string[]> {
  if (!targets.length) return []
  const rows = await Promise.all(
    targets.map(async (t) => {
      const stages = await imageStages(t, root)
      const status = targetStatus(stages)
      const worst = stages.find((s) => s.status === status)
      return { t, status, detail: status === 'ready' ? '' : `: ${worst?.what}, ${worst?.detail}` }
    }),
  )
  const count = (w: StageStatus) => rows.filter((r) => r.status === w).length
  const summary = WORST.filter((w) => count(w))
    .reverse()
    .map((w) => `${count(w)} ${WORDS[w]}`)
    .join(', ')
  const width = Math.max(...rows.map((r) => r.t.id.length))
  return [
    `images  ${targets.length} sandbox image${targets.length === 1 ? '' : 's'}: ${summary}`,
    ...rows.map(
      (r) => `  ${MARKS[r.status]} ${r.t.id.padEnd(width)}  ${WORDS[r.status]}${r.detail}`,
    ),
  ]
}

export type BuiltImage = ImageTarget &
  (
    | { ok: true; image: AttemptImage; ms: number }
    | { ok: false; failure: PrepareFailure; ms: number }
  )

/**
 * `reeval image build`: prepares every target, three at a time, and reports each, failures too.
 * `from` images are rebuilt when their tag moved upstream, and everything with `force`. With a
 * `registry`, an image that's missing here is pulled from it before it's built, and with `push`
 * every image reeval made for a target is pushed to it.
 */
export async function buildImages(
  targets: ImageTarget[],
  root: string,
  options: {
    log: (line: string) => void
    force?: boolean
    delays?: number[]
    registry?: string | null
    push?: boolean
  },
): Promise<BuiltImage[]> {
  const providers = createProviders({
    refresh: options.force ? 'force' : 'check',
    registry: options.registry ?? null,
    push: !!options.push,
  })
  const prepared = targets.map((t) => ({
    kind: sandboxProvider(t.sandbox),
    key: dockerKey(t.sandbox, harnessFor(t.harness), t.plugins),
    label: t.id,
    sandbox: t.sandbox,
    harness: harnessFor(t.harness),
    plugins: t.plugins,
    setBy: [],
    runWide: false,
  }))
  const outcomes = await prepareAll(prepared, {
    providers,
    root,
    log: options.log,
    ...(options.delays ? { delays: options.delays } : {}),
  })
  return targets.map((t, i) => {
    const o = outcomes[i] as (typeof outcomes)[number]
    return o.ok
      ? { ...t, ok: true, image: attemptImage(o.handle), ms: o.ms }
      : { ...t, ok: false, failure: o.failure, ms: o.ms }
  })
}

/**
 * One image `tart()` clones, with how many evals use it, the sandbox the first names it in and the
 * harness baked into it (none for a fake agent without a bootstrap: it clones the image itself).
 */
export type TartTarget = {
  id: string
  sandbox: TartSandboxDescriptor
  harness: HarnessDescriptor
  bake: TartBake | null
  evals: number
  /** The evals that use it. */
  ids: readonly string[]
}

/** The distinct `tart()` images and the harnesses baked into each, in first-use order. */
export function tartTargets(uses: ImageUse[]): TartTarget[] {
  const targets = new Map<string, Omit<TartTarget, 'ids'> & { seen: Set<string> }>()
  for (const { id, sandbox, harness } of uses) {
    if (sandbox.kind !== 'tart') continue
    const bake = tartBake(harness)
    const key = tartBakeKey(sandbox, harness)
    const user = sandbox.ssh?.user ? ` as ${sandbox.ssh.user}` : ''
    const target = targets.get(key) ?? {
      id: bake ? `${sandboxId(sandbox)} · ${bake.label}${user}` : sandboxId(sandbox),
      sandbox,
      harness,
      bake,
      evals: 0,
      seen: new Set(),
    }
    if (!target.seen.has(id)) {
      target.seen.add(id)
      target.evals++
    }
    targets.set(key, target)
  }
  return [...targets.values()].map(({ seen, ...t }) => ({ ...t, ids: [...seen] }))
}

/**
 * `reeval image build --dry-run`: whether Tart has each image, what a missing one weighs, and
 * whether each harness is baked into it yet.
 */
export async function tartPlanLines(targets: TartTarget[]): Promise<string[]> {
  const { tartNames } = await import('./tart-cli.ts')
  const {
    formatSize,
    pullSpace,
    pullSpaceLine,
    pullSpaceUnknown,
    tartDigest,
    tartImageSize,
    tartSource,
  } = await import('./tart-images.ts')
  const { parseTartRef, tartListed } = await import('./tart-ref.ts')
  const have = await tartNames().catch((error: Error) => error)
  const images = [...new Map(targets.map((t) => [t.sandbox.image, t])).values()]
  const lines = [
    `tart  ${images.length} image${images.length === 1 ? '' : 's'} (nothing pulled or baked: --dry-run)`,
  ]
  const missing: MissingImage[] = []
  for (const t of images) {
    const { image } = t.sandbox
    const id = sandboxId(t.sandbox)
    const evals = new Set(targets.filter((o) => o.sandbox.image === image).flatMap((o) => o.ids))
    const uses = evals.size ? ` · ${evals.size} eval${evals.size === 1 ? '' : 's'}` : ''
    if (have instanceof Error) {
      lines.push(`  ? ${id}${uses}  ${image}  (unchecked: ${have.message.split('\n')[0]})`)
    } else if (tartListed(have, image)) {
      const digest = await tartDigest(image)
      lines.push(`  ✓ ${id}${uses}  ${image}  (ready${digest ? `: ${short(digest)}` : ''})`)
    } else {
      const size = await tartImageSize(image, AbortSignal.timeout(10_000))
      const weighs = size ? `: about ${formatSize(size.download)} to download` : ': size unknown'
      lines.push(`  + ${id}${uses}  ${image}  (to pull${weighs})`)
      if (parseTartRef(image).oci) missing.push({ image, size })
    }
    for (const b of targets.filter((o) => o.sandbox.image === image && o.bake)) {
      const bake = b.bake as TartBake
      if (have instanceof Error) continue
      if (!tartListed(have, image)) {
        lines.push(`    + ${b.id}  (to bake ${bake.name} onto it once it's pulled)`)
        continue
      }
      const baked = await bakedTartImage(b.sandbox, bake, await tartSource(image))
      lines.push(
        have.has(baked)
          ? `    ✓ ${b.id}  ${baked}  (baked)`
          : `    + ${b.id}  ${baked}  (to bake: pnpm and ${bake.name})`,
      )
    }
  }
  if (missing.length && !(have instanceof Error)) {
    const present = images.map((t) => t.sandbox.image).filter((i) => tartListed(have, i))
    const space = await pullSpace(missing, present)
    lines.push(`  ${space ? pullSpaceLine(space) : pullSpaceUnknown()}`)
  }
  return lines
}

export type PulledImage = TartTarget &
  ({ ok: true; image: VmImage; ms: number } | { ok: false; failure: PrepareFailure; ms: number })

/**
 * `reeval image build`: pulls every image Tart doesn't have, once the disk has room for all of
 * them, bakes each harness into its own image of each, and reports each with its digest (a baked
 * one by its name). Runs no Docker.
 */
export async function pullTartImages(
  targets: TartTarget[],
  root: string,
  options: { log: (line: string) => void; delays?: number[]; force?: boolean },
): Promise<PulledImage[]> {
  const providers = createProviders({ pull: true, force: !!options.force })
  const prepared = targets.map((t) => ({
    kind: 'tart',
    key: providers.tart?.key(t.sandbox, t.harness) ?? t.sandbox.image,
    label: t.id,
    sandbox: t.sandbox,
    harness: t.harness,
    plugins: [],
    setBy: [],
    runWide: false,
  }))
  const outcomes = await prepareAll(prepared, {
    providers,
    root,
    log: options.log,
    ...(options.delays ? { delays: options.delays } : {}),
  })
  return targets.map((t, i) => {
    const o = outcomes[i] as (typeof outcomes)[number]
    const image = o.ok ? vmImage(o.handle) : null
    const baked = o.ok ? bakedImage(o.handle) : null
    return image
      ? { ...t, ok: true, image: baked ? { ref: baked, digest: image.digest } : image, ms: o.ms }
      : {
          ...t,
          ok: false,
          failure: o.ok ? classifyTart(new Error('tart() prepared no image')) : o.failure,
          ms: o.ms,
        }
  })
}

/** A harness descriptor for a baked harness: the fake one in its layout. */
const harnessFor = (harness: BakedHarness): HarnessDescriptor => ({ kind: 'fake', layout: harness })
