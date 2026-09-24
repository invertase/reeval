import { UsageError } from './config.ts'
import { dockerAvailable, imageLabels } from './sandbox/docker-cli.ts'
import { DEFAULT_IMAGE, LABEL } from './sandbox/image.ts'
import type { ResolvedConfig } from './types.ts'

export type SandboxVersions = { agentCli: string | null; image: string }

/** Checks Docker and the sandbox image before any eval starts. */
export async function preflight(config: ResolvedConfig): Promise<SandboxVersions> {
  if (config.sandbox.kind === 'fake') return { agentCli: null, image: 'none (fake sandbox)' }
  if (!(await dockerAvailable())) {
    throw new UsageError('Docker is not running. Start Docker and try again.')
  }
  const image = config.sandbox.image ?? DEFAULT_IMAGE
  const labels = await imageLabels(image)
  if (!labels) {
    throw new UsageError(`Sandbox image ${image} not found. Build it once with: es image build`)
  }
  return { agentCli: labels[LABEL.agentVersion] ?? null, image }
}
