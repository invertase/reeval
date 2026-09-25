// `es image build`: every image the planned attempts' Docker sandboxes need, built or listed.
import {
  buildImage,
  DEFAULT_IMAGE,
  dockerAvailable,
  dockerfileTag,
  ES_BASE_ARG,
  harnessImageFor,
  imageInfo,
} from '@evalsuite/sandbox-docker'
import { UsageError } from '../errors.ts'
import { sandboxId } from '../options.ts'
import type { AttemptImage, DockerSandboxDescriptor, SandboxDescriptor } from '../types.ts'
import { installSteps, prepareImage, projectPath, type Rebuild, usesEsBase } from './prepare.ts'

/** `id` is the sandbox's cell id, plus `+ install` and a number where that's ambiguous. */
export type ImageTarget = { id: string; sandbox: DockerSandboxDescriptor; evals: number }

/** The distinct Docker sandboxes, in first-use order, with how many evals use each. */
export function imageTargets(uses: Array<{ id: string; sandbox: SandboxDescriptor }>) {
  const targets = new Map<string, ImageTarget & { seen: Set<string> }>()
  for (const { id, sandbox } of uses) {
    if (sandbox.kind !== 'docker') continue
    const { maxConcurrent: _, id: __, ...image } = sandbox
    const key = JSON.stringify(image)
    const target = targets.get(key) ?? {
      id: sandboxId(sandbox),
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
  const { sandbox } = target
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
      ref: harnessImageFor(sandbox.from),
      action: 'rebuild: Node, git and the harness bootstrap on top',
    })
  } else if (sandbox.dockerfile) {
    const { tag } = dockerfileTag(sandbox.dockerfile)
    stages.push({
      what: `dockerfile ${projectPath(root, sandbox.dockerfile)}`,
      ref: tag,
      action: 'docker build (layer cache), tagged by content hash',
    })
    stages.push(
      usesEsBase(sandbox.dockerfile)
        ? { what: 'harness', ref: tag, action: `inherited: FROM \${${ES_BASE_ARG}}` }
        : {
            what: 'harness',
            ref: harnessImageFor(tag),
            action: 'rebuild: Node, git and the harness bootstrap on top',
          },
    )
  } else {
    stages.push({ what: 'base', ref: DEFAULT_IMAGE, action: 'rebuild: the harness bootstrap' })
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

/** Whether ES's own image has to be built first: used directly, or as a Dockerfile's base. */
export const needsDefault = (targets: ImageTarget[]) =>
  targets.some(
    ({ sandbox: s }) =>
      (!s.image && !s.from && !s.dockerfile) || (s.dockerfile && usesEsBase(s.dockerfile)),
  )

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
  const rebuild: Rebuild = { done: new Set() }
  if (needsDefault(targets)) {
    await buildImage(log)
    rebuild.done.add(DEFAULT_IMAGE)
  }
  const signal = new AbortController().signal
  const built: Array<ImageTarget & { image: AttemptImage }> = []
  for (const target of targets) {
    log(`Preparing ${target.id}`)
    built.push({
      ...target,
      image: await prepareImage(target.sandbox, root, signal, { log, rebuild }),
    })
  }
  return built
}
