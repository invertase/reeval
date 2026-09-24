import { posix } from 'node:path'
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness'
import type { DockerSandboxDescriptor } from '../types.ts'
import { imageLabels } from './docker-cli.ts'
import { createDockerSession } from './docker-provider.ts'
import { DEFAULT_IMAGE, LABEL, SANDBOX_ROOT, WORKSPACE_DIR } from './image.ts'
import type { SandboxOptions } from './index.ts'
import { InfraError, type Sandbox } from './types.ts'

/** A Docker sandbox also exposes its harness session, so the harness drives the same container. */
export type DockerSandbox = Sandbox & { readonly network: HarnessV1NetworkSandboxSession }

export const isDockerSandbox = (s: Sandbox): s is DockerSandbox => 'network' in s

export async function createDockerSandbox(
  descriptor: DockerSandboxDescriptor,
  options: SandboxOptions,
): Promise<DockerSandbox> {
  const image = descriptor.image ?? DEFAULT_IMAGE
  if (!(await imageLabels(image))) {
    throw new InfraError(`Docker image ${image} not found. Build it with: es image build`)
  }
  const network = await createDockerSession({
    image,
    labels: { [LABEL.run]: options.runId },
    lifetimeMs: options.timeoutMs,
    abortSignal: options.signal,
  })
  const workdir = posix.join(SANDBOX_ROOT, WORKSPACE_DIR)
  const resolve = (path: string) => posix.resolve(workdir, path)
  await network.run({ command: `mkdir -p ${workdir}` })

  return {
    workdir,
    network,
    exec: async (command, opts) =>
      network.run({ command, workingDirectory: workdir, abortSignal: opts?.signal }),
    readFile: async (path) => (await network.readTextFile({ path: resolve(path) })) ?? null,
    writeFile: async (path, content) => network.writeTextFile({ path: resolve(path), content }),
    destroy: async () => {
      await Promise.resolve(network.destroy()).catch(() => {})
    },
  }
}
