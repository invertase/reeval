import { UsageError } from './config.ts'
import { dockerAvailable, imageInfo } from './sandbox/docker-cli.ts'
import { DEFAULT_IMAGE, LABEL } from './sandbox/image.ts'
import type { ResolvedConfig } from './types.ts'

export type SandboxImage = { ref: string; id: string; repoDigests: string[] }
export type SandboxVersions = { agentCli: string | null; image: SandboxImage | null }

/** Checks Docker and the sandbox image before any eval starts. */
export async function preflight(config: ResolvedConfig): Promise<SandboxVersions> {
  if (config.sandbox.kind === 'fake') return { agentCli: null, image: null }
  if (!(await dockerAvailable())) {
    throw new UsageError('Docker is not running. Start Docker and try again.')
  }
  const image = config.sandbox.image ?? DEFAULT_IMAGE
  const info = await imageInfo(image)
  if (!info) {
    throw new UsageError(`Sandbox image ${image} not found. Build it once with: es image build`)
  }
  return {
    agentCli: info.labels[LABEL.agentVersion] ?? null,
    image: { ref: image, id: info.id, repoDigests: info.repoDigests },
  }
}
