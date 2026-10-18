// `reeval image build`: every image the planned attempts' Docker sandboxes need, built or listed.
import {
  type BakedHarness,
  contextHash,
  dockerfileTag,
  harnessImageFor,
  imageFor,
  imageInfo,
  installLayerTag,
  isTransient,
  LABEL,
  REEVAL_BASE_ARG,
  resolveFrom,
} from '@reeval/sandbox-docker'
import { sandboxId } from '../options.ts'
import type {
  AttemptImage,
  DockerSandboxDescriptor,
  HarnessDescriptor,
  SandboxDescriptor,
} from '../types.ts'
import { prepareAll } from './preflight.ts'
import { imageHarness, installSteps, projectPath, usesReevalBase } from './prepare.ts'
import type { PrepareFailure } from './provider.ts'
import { attemptImage, createProviders, dockerKey } from './providers.ts'

/**
 * One image to make: a Docker sandbox for one harness's CLI. `id` is the sandbox's cell id, plus
 * the harness unless it's Cursor, `+ install`, and a number where that's still ambiguous.
 */
export type ImageTarget = {
  id: string
  harness: BakedHarness
  sandbox: DockerSandboxDescriptor
  evals: number
}

/** The distinct Docker sandbox and harness pairs, in first-use order, with how many evals use each. */
export function imageTargets(
  uses: Array<{ id: string; harness: HarnessDescriptor; sandbox: SandboxDescriptor }>,
) {
  const targets = new Map<string, ImageTarget & { seen: Set<string> }>()
  for (const { id, sandbox, ...use } of uses) {
    if (sandbox.kind !== 'docker') continue
    const harness = imageHarness(use.harness)
    // What's in the image, not the limits or user the container runs with.
    const { image, from, dockerfile, install } = sandbox
    const key = JSON.stringify({ harness, image: { image, from, dockerfile, install } })
    const target = targets.get(key) ?? {
      id: harness === 'cursor' ? sandboxId(sandbox) : `${sandboxId(sandbox)} · ${harness}`,
      harness,
      sandbox,
      evals: 0,
      seen: new Set(),
    }
    if (!target.seen.has(id)) {
      target.seen.add(id)
      target.evals++
    }
    targets.set(key, target)
  }
  // Cell ids ignore install, so tell sandboxes apart by it, then by number.
  const labels = new Map<string, number>()
  return [...targets.values()].map(({ seen: _, ...t }) => {
    const label = `${t.id}${t.sandbox.install?.length ? ' + install' : ''}`
    const n = (labels.get(label) ?? 0) + 1
    labels.set(label, n)
    return { ...t, id: n === 1 ? label : `${label} (${n})` }
  })
}

/** How a step of making an image would go, checked without building or pulling. */
export type StageStatus = 'ready' | 'build' | 'stale' | 'missing'

/** `action` says how the step works; `status` and `detail`, how it stands on this machine. */
export type Stage = {
  what: string
  ref: string
  action: string
  status: StageStatus
  detail: string
}

const short = (digest: string) => digest.replace(/^sha256:/, '').slice(0, 12)

/** `from`'s image, checked against what the tag names now (a registry lookup, no pull). */
async function fromStatus(from: string, ref: string): Promise<Pick<Stage, 'status' | 'detail'>> {
  const [cached, now] = await Promise.all([imageInfo(ref), resolveFrom(from)])
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

/** How each target's image is made, in build order, and how each step stands, building nothing. */
export async function imageStages(target: ImageTarget, root: string): Promise<Stage[]> {
  const { sandbox, harness } = target
  const stages: Stage[] = []
  type Probe = { info: Awaited<ReturnType<typeof imageInfo>>; status: StageStatus; detail: string }
  const exists = async (ref: string): Promise<Probe> => {
    const info = await imageInfo(ref)
    return {
      info,
      status: info ? 'ready' : 'build',
      detail: info ? `built (${short(info.id)})` : 'not built yet',
    }
  }
  const reevalBase = async (): Promise<Probe> => {
    const info = await imageInfo(imageFor(harness))
    if (!info) return { info, status: 'build', detail: 'not built yet' }
    return info.labels[LABEL.context] === contextHash()
      ? { info, status: 'ready', detail: `built (${short(info.id)})` }
      : {
          info,
          status: 'stale',
          detail: "reeval's base changed: rebuilt before the run",
        }
  }
  let parent: string | null = null
  if (sandbox.image) {
    const found = await imageInfo(sandbox.image)
    parent = found?.id ?? null
    stages.push({
      what: 'image',
      ref: sandbox.image,
      action: 'used as is',
      ...(found
        ? { status: 'ready', detail: `found (${short(found.id)})` }
        : { status: 'missing', detail: 'not found: pull or build it yourself' }),
    })
  } else if (sandbox.from) {
    const ref = harnessImageFor(harness, sandbox.from)
    const status = await fromStatus(sandbox.from, ref)
    parent = status.status === 'ready' ? ((await imageInfo(ref))?.id ?? null) : null
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
    const real = dockerfileTag(sandbox.dockerfile, harness, base?.info?.id ?? null).tag
    // Its tag hashes reeval's image id, which is this machine's, so the plan names it by kind.
    const tag = onReeval ? real.replace(/-[0-9a-f]{16}$/, '-<context + reeval image id>') : real
    const built = await exists(real)
    stages.push({
      what: `dockerfile ${projectPath(root, sandbox.dockerfile)}`,
      ref: tag,
      action: 'docker build (layer cache), tagged by content hash',
      status: built.status,
      detail: built.info || !onReeval ? built.detail : `${built.detail} (${real})`,
    })
    if (onReeval) {
      parent = built.info?.id ?? null
      stages.push({
        what: 'harness',
        ref: tag,
        action: `inherited: FROM \${${REEVAL_BASE_ARG}}, which is ${imageFor(harness)}`,
        status: base?.status ?? 'build',
        detail: `${imageFor(harness)} ${base?.detail ?? ''}`.trim(),
      })
    } else {
      const baked = await exists(harnessImageFor(harness, real))
      parent = baked.info?.id ?? null
      stages.push({
        what: 'harness',
        ref: harnessImageFor(harness, tag),
        action: 'Node, git and the harness bootstrap on top',
        status: baked.status,
        detail: baked.detail,
      })
    }
  } else {
    const base = await reevalBase()
    parent = base.status === 'ready' ? (base.info?.id ?? null) : null
    stages.push({
      what: 'base',
      ref: imageFor(harness),
      action: "reeval's image: built when missing or when its base changed",
      status: base.status,
      detail: base.detail,
    })
  }
  const steps = installSteps(sandbox)
  if (steps.length) {
    const layer = parent ? await exists(installLayerTag({ id: parent }, steps)) : null
    stages.push({
      what: `install ${steps.length} command${steps.length === 1 ? '' : 's'}`,
      ref: 'reeval-install:<base id + commands>',
      action: 'build unless cached',
      status: layer?.status ?? 'build',
      detail: layer?.detail ?? 'not built yet',
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

const WORST: StageStatus[] = ['missing', 'stale', 'build', 'ready']
const MARKS: Record<StageStatus, string> = { ready: '✓', build: '+', stale: '~', missing: '✗' }
const WORDS: Record<StageStatus, string> = {
  ready: 'ready',
  build: 'to build',
  stale: 'stale',
  missing: 'missing',
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
 * `from` images are rebuilt when their tag moved upstream, and everything with `force`.
 */
export async function buildImages(
  targets: ImageTarget[],
  root: string,
  options: { log: (line: string) => void; force?: boolean; delays?: number[] },
): Promise<BuiltImage[]> {
  const providers = createProviders({ refresh: options.force ? 'force' : 'check' })
  const prepared = targets.map((t) => ({
    kind: 'docker',
    key: dockerKey(t.sandbox, harnessFor(t.harness)),
    label: t.id,
    sandbox: t.sandbox,
    harness: harnessFor(t.harness),
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

/** A harness descriptor for a baked harness: the fake one in its layout. */
const harnessFor = (harness: BakedHarness): HarnessDescriptor => ({ kind: 'fake', layout: harness })
