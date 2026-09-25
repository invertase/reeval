import { dockerAvailable, imageFor, imageInfo, LABEL } from '@evalsuite/sandbox-docker'
import { UsageError } from './errors.ts'
import type { ImageTarget } from './sandbox/images.ts'

export type SandboxImage = {
  ref: string
  id: string
  repoDigests: string[]
  agentCli: string | null
}
/** The config's Docker images, found before the run; groups and evals may add others. */
export type SandboxVersions = { images: SandboxImage[] }

/** Checks Docker and the planned attempts' sandbox images before any eval starts. */
export async function preflight(targets: ImageTarget[]): Promise<SandboxVersions> {
  if (targets.length === 0) return { images: [] }
  if (!(await dockerAvailable())) {
    throw new UsageError('Docker is not running. Start Docker and try again.')
  }
  const images: SandboxImage[] = []
  // `from` and `dockerfile` images are built on first use, so there's nothing to check yet.
  const refs = new Set(
    targets
      .filter(({ sandbox: s }) => !s.from && !s.dockerfile)
      .map(({ sandbox, harness }) => sandbox.image ?? imageFor(harness)),
  )
  for (const ref of refs) {
    const info = await imageInfo(ref)
    if (!info) {
      throw new UsageError(
        targets.some((t) => !t.sandbox.image && imageFor(t.harness) === ref)
          ? `Sandbox image ${ref} not found. Build it once with: es image build`
          : `Sandbox image ${ref} not found. docker({ image }) is used as is, so pull or build it first.`,
      )
    }
    images.push({
      ref,
      id: info.id,
      repoDigests: info.repoDigests,
      agentCli: info.labels[LABEL.agentVersion] ?? null,
    })
  }
  return { images }
}
