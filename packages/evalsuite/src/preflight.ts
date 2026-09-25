import { dockerAvailable, imageFor, imageInfo, LABEL } from '@evalsuite/sandbox-docker'
import { UsageError } from './errors.ts'
import { bakedHarnessFor, imageHint } from './sandbox/prepare.ts'
import type { HarnessDescriptor, SandboxDescriptor } from './types.ts'

/** A harness and the sandbox it runs in: together they say which image an attempt needs. */
export type Stack = { harness: HarnessDescriptor; sandbox: SandboxDescriptor }

export type SandboxImage = {
  ref: string
  id: string
  repoDigests: string[]
  agentCli: string | null
}
/** The config's Docker images, found before the run; groups and evals may add others. */
export type SandboxVersions = { images: SandboxImage[] }

/** Checks Docker and the planned attempts' sandbox images before any eval starts. */
export async function preflight(stacks: Stack[]): Promise<SandboxVersions> {
  const dockers = stacks.flatMap(({ harness, sandbox }) =>
    sandbox.kind === 'docker' ? [{ harness, sandbox }] : [],
  )
  if (dockers.length === 0) return { images: [] }
  if (!(await dockerAvailable())) {
    throw new UsageError('Docker is not running. Start Docker and try again.')
  }
  const images: SandboxImage[] = []
  // `from` images are built on first use, so there's nothing to check yet.
  const refs = new Set<string>()
  for (const { harness, sandbox } of dockers) {
    if (!sandbox.from) refs.add(sandbox.image ?? imageFor(bakedHarnessFor(harness)))
  }
  for (const ref of refs) {
    const info = await imageInfo(ref)
    if (!info) throw new UsageError(`Sandbox image ${ref} not found. ${imageHint(ref)}`)
    images.push({
      ref,
      id: info.id,
      repoDigests: info.repoDigests,
      agentCli: info.labels[LABEL.agentVersion] ?? null,
    })
  }
  return { images }
}
