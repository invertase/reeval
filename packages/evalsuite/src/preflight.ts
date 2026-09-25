import { DEFAULT_IMAGE, dockerAvailable, imageInfo, LABEL } from '@evalsuite/sandbox-docker'
import { UsageError } from './errors.ts'
import type { ResolvedConfig } from './types.ts'

export type SandboxImage = {
  ref: string
  id: string
  repoDigests: string[]
  agentCli: string | null
}
/** The config's Docker images, found before the run; groups and evals may add others. */
export type SandboxVersions = { images: SandboxImage[] }

/** Checks Docker and the config's sandbox images before any eval starts. */
export async function preflight(config: ResolvedConfig): Promise<SandboxVersions> {
  const dockers = config.sandbox.flatMap((s) => (s.kind === 'docker' ? [s] : []))
  if (dockers.length === 0) return { images: [] }
  if (!(await dockerAvailable())) {
    throw new UsageError('Docker is not running. Start Docker and try again.')
  }
  const images: SandboxImage[] = []
  // `from` images are built on first use, so there's nothing to check yet.
  for (const s of dockers.filter((d) => !d.from)) {
    const ref = s.image ?? DEFAULT_IMAGE
    const info = await imageInfo(ref)
    if (!info) {
      throw new UsageError(`Sandbox image ${ref} not found. Build it once with: es image build`)
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
