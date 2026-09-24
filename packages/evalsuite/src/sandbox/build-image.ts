import { fileURLToPath } from 'node:url'
import { prepareSandboxForHarness } from '@ai-sdk/harness/agent'
import { createCursor } from '@ai-sdk/harness-cursor'
import { docker, dockerOk } from './docker-cli.ts'
import { createDockerSession } from './docker-provider.ts'
import {
  BASE_IMAGE,
  DEFAULT_IMAGE,
  HARNESS_CURSOR_VERSION,
  LABEL,
  SANDBOX_ROOT,
  WORKSPACE_DIR,
} from './image.ts'

/**
 * Bakes the Cursor harness bootstrap (which installs the Cursor CLI) into an image, so the
 * image tag pins the CLI build. Rebuild after bumping `@ai-sdk/harness-cursor`.
 */
export async function buildImage(
  log: (line: string) => void,
): Promise<{ image: string; agentVersion: string }> {
  const context = fileURLToPath(new URL('../../docker', import.meta.url))
  log(`Building ${BASE_IMAGE}`)
  const build = await docker(['build', '--quiet', '--tag', BASE_IMAGE, context])
  if (build.exitCode !== 0) throw new Error(`docker build failed:\n${build.stderr}`)

  log('Installing the Cursor harness bootstrap')
  const session = await createDockerSession({ image: BASE_IMAGE, lifetimeMs: 30 * 60_000 })
  try {
    await prepareSandboxForHarness({
      session,
      harnesses: [createCursor()],
      sandboxConfig: { workDir: WORKSPACE_DIR },
    })
    const found = await session.run({
      command: `find "$HOME/.ai-sdk-harness" -name agent \\( -type f -o -type l \\) -perm -u+x | head -1`,
    })
    const bin = found.stdout.trim()
    if (!bin) throw new Error('The harness bootstrap did not install the Cursor CLI')
    const version = await session.run({ command: `'${bin}' --version` })
    const agentVersion = version.stdout.trim() || 'unknown'
    log(`Cursor CLI ${agentVersion}`)

    await dockerOk([
      'commit',
      '--change',
      `LABEL ${LABEL.agentVersion}="${agentVersion}" ${LABEL.harness}="@ai-sdk/harness-cursor@${HARNESS_CURSOR_VERSION}"`,
      '--change',
      `WORKDIR ${SANDBOX_ROOT}`,
      '--change',
      'ENTRYPOINT []',
      '--change',
      'CMD ["bash"]',
      session.id,
      DEFAULT_IMAGE,
    ])
    return { image: DEFAULT_IMAGE, agentVersion }
  } finally {
    await session.destroy()
  }
}
