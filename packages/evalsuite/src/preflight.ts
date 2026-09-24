import { UsageError } from './errors.ts'
import { dockerAvailable, imageInfo } from './sandbox/docker-cli.ts'
import { DEFAULT_IMAGE, LABEL } from './sandbox/image.ts'
import type { ResolvedConfig } from './types.ts'

export type SandboxImage = {
  ref: string
  id: string
  repoDigests: string[]
  agentCli: string | null
}
/** The config's Docker images, found before the run; groups and evals may add others. */
export type SandboxVersions = { images: SandboxImage[] }

/**
 * Digests someone else could pull. Docker's containerd image store gives a locally built image a
 * `name@sha256:…` digest too; for an image ES built under a bare name (`evalsuite-sandbox`) that
 * would point at Docker Hub's official library, where it was never pushed.
 */
export function pullableDigests(info: { repoDigests: string[]; labels: Record<string, string> }) {
  if (info.labels[LABEL.managed] !== 'true') return info.repoDigests
  return info.repoDigests.filter((d) => d.slice(0, d.indexOf('@')).includes('/'))
}

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
      repoDigests: pullableDigests(info),
      agentCli: info.labels[LABEL.agentVersion] ?? null,
    })
  }
  return { images }
}
