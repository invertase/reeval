// `es image build`: every image the planned attempts' Docker sandboxes need, built or listed.
import {
  type BakedHarness,
  dockerAvailable,
  dockerfileTag,
  ES_BASE_ARG,
  harnessImageFor,
  imageFor,
  imageInfo,
  retryTransient,
} from '@evalsuite/sandbox-docker'
import { UsageError } from '../errors.ts'
import { sandboxId } from '../options.ts'
import type {
  AttemptImage,
  DockerSandboxDescriptor,
  HarnessDescriptor,
  SandboxDescriptor,
} from '../types.ts'
import {
  createBuilds,
  imageHarness,
  installSteps,
  prepareImage,
  projectPath,
  usesEsBase,
} from './prepare.ts'

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

type Stage = { what: string; ref: string; action: string }

/** How each target's image is made, in build order, without building anything. */
export async function imageStages(target: ImageTarget, root: string): Promise<Stage[]> {
  const { sandbox, harness } = target
  const stages: Stage[] = []
  if (sandbox.image) {
    const found = await imageInfo(sandbox.image)
    stages.push({
      what: 'image',
      ref: sandbox.image,
      action: found ? 'used as is' : 'missing: pull or build it yourself',
    })
  } else if (sandbox.from) {
    stages.push({
      what: `from ${sandbox.from}`,
      ref: harnessImageFor(harness, sandbox.from),
      action: 'rebuild: Node, git and the harness bootstrap on top',
    })
  } else if (sandbox.dockerfile) {
    // Its tag hashes ES's image id, which is this machine's, so the plan names it by kind.
    const onEs = usesEsBase(sandbox.dockerfile)
    const { tag: hashed } = dockerfileTag(sandbox.dockerfile, harness)
    const tag = onEs ? hashed.replace(/-[0-9a-f]{16}$/, '-<context + ES image id>') : hashed
    stages.push({
      what: `dockerfile ${projectPath(root, sandbox.dockerfile)}`,
      ref: tag,
      action: 'docker build (layer cache), tagged by content hash',
    })
    stages.push(
      usesEsBase(sandbox.dockerfile)
        ? {
            what: 'harness',
            ref: tag,
            action: `inherited: FROM \${${ES_BASE_ARG}}, which is ${imageFor(harness)}`,
          }
        : {
            what: 'harness',
            ref: harnessImageFor(harness, tag),
            action: 'rebuild: Node, git and the harness bootstrap on top',
          },
    )
  } else {
    stages.push({ what: 'base', ref: imageFor(harness), action: 'rebuild: the harness bootstrap' })
  }
  const steps = installSteps(sandbox)
  if (steps.length) {
    stages.push({
      what: `install ${steps.length} command${steps.length === 1 ? '' : 's'}`,
      ref: 'evalsuite-install:<base id + commands>',
      action: 'build unless cached',
    })
  }
  return stages
}

/** ES's harness images to build first: used directly, or as a Dockerfile's `ES_BASE`. */
export const esImages = (targets: ImageTarget[]): BakedHarness[] => [
  ...new Set(
    targets
      .filter(
        ({ sandbox: s }) =>
          (!s.image && !s.from && !s.dockerfile) || (s.dockerfile && usesEsBase(s.dockerfile)),
      )
      .map((t) => t.harness),
  ),
]

/** `es image build --dry-run`: one block per sandbox. */
export async function imagePlanLines(targets: ImageTarget[], root: string): Promise<string[]> {
  const lines = [
    `images  ${targets.length} sandbox image${targets.length === 1 ? '' : 's'} (nothing built: --dry-run)`,
  ]
  for (const target of targets) {
    const uses = target.evals ? ` · ${target.evals} eval${target.evals === 1 ? '' : 's'}` : ''
    lines.push(`${target.id}${uses}`)
    const stages = await imageStages(target, root)
    const width = Math.max(...stages.map((s) => s.what.length))
    for (const s of stages) lines.push(`  ${s.what.padEnd(width)}  ${s.ref}  (${s.action})`)
  }
  return lines
}

/**
 * Builds ES's image when a target needs it, then every target's image: harness images and
 * Dockerfiles are rebuilt once each, install layers only when their base or commands changed.
 */
export async function buildImages(
  targets: ImageTarget[],
  root: string,
  log: (line: string) => void,
): Promise<Array<ImageTarget & { image: AttemptImage }>> {
  if (!(await dockerAvailable())) {
    throw new UsageError('Docker is not running. Start Docker and try again.')
  }
  for (const { sandbox } of targets) {
    if (sandbox.image && !(await imageInfo(sandbox.image))) {
      throw new UsageError(
        `Sandbox image ${sandbox.image} not found. docker({ image }) is used as is, so pull or build it first.`,
      )
    }
  }
  // Harness images for `from` and Dockerfiles are rebuilt once each; ES's own image when its
  // base changed; install layers when their base or commands did.
  const builds = createBuilds({ log, force: true, retry: (step) => retryTransient(step) })
  const signal = new AbortController().signal
  const built: Array<ImageTarget & { image: AttemptImage }> = []
  for (const target of targets) {
    log(`Preparing ${target.id}`)
    built.push({
      ...target,
      image: await prepareImage(target.sandbox, target.harness, root, signal, builds),
    })
  }
  return built
}
