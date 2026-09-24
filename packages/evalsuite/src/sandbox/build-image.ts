import { fileURLToPath } from 'node:url'
import { prepareSandboxForHarness } from '@ai-sdk/harness/agent'
import { createCursor } from '@ai-sdk/harness-cursor'
import { sha256, slugify } from '../ids.ts'
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

const PNPM_VERSION = '10.33.3'

/** The image `docker({ from })` evals run in: `from` plus Node, git and the baked harness. */
export const harnessImageFor = (from: string) =>
  `${DEFAULT_IMAGE}-${slugify(from, 40) || 'image'}-${sha256(from).slice(0, 8)}`

/**
 * Adds what the harness bridge needs to a Debian or Ubuntu based toolchain image: Node (copied
 * from the official image, so the base's own toolchain is untouched), pnpm, git, curl and bash.
 */
const toolchainDockerfile = (from: string) => `FROM ${from}
SHELL ["/bin/sh", "-c"]
RUN command -v apt-get >/dev/null || { echo "ES needs a Debian or Ubuntu based image (glibc and apt-get)" >&2; exit 1; } \\
  && apt-get update \\
  && apt-get install -y --no-install-recommends bash ca-certificates curl git procps \\
  && rm -rf /var/lib/apt/lists/*
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \\
  && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \\
  && npm install --global pnpm@${PNPM_VERSION} \\
  && mkdir -p ${SANDBOX_ROOT}/${WORKSPACE_DIR}
WORKDIR ${SANDBOX_ROOT}/${WORKSPACE_DIR}
`

const tail = (text: string) => text.trim().split('\n').slice(-15).join('\n')

/**
 * Bakes the Cursor harness bootstrap (which installs the Cursor CLI) into an image, so the
 * image tag pins the CLI build. Rebuild after bumping `@ai-sdk/harness-cursor`. With `from`,
 * the base is that toolchain image instead of ES's Node image.
 */
export async function buildImage(
  log: (line: string) => void,
  options: { from?: string; signal?: AbortSignal } = {},
): Promise<{ image: string; agentVersion: string }> {
  const { from, signal } = options
  const base = from ? `${harnessImageFor(from)}-base` : BASE_IMAGE
  const target = from ? harnessImageFor(from) : DEFAULT_IMAGE
  log(`Building ${base}${from ? ` from ${from}` : ''}`)
  const build = from
    ? await docker(['build', '--quiet', '--tag', base, '-'], {
        input: toolchainDockerfile(from),
        signal,
      })
    : await docker(
        [
          'build',
          '--quiet',
          '--tag',
          base,
          fileURLToPath(new URL('../../docker', import.meta.url)),
        ],
        { signal },
      )
  if (build.exitCode !== 0) {
    throw new Error(
      `Building the sandbox image${from ? ` FROM ${from}` : ''} failed:\n${tail(build.stderr)}`,
    )
  }

  log('Installing the Cursor harness bootstrap')
  const session = await createDockerSession({
    image: base,
    lifetimeMs: 30 * 60_000,
    ...(signal ? { abortSignal: signal } : {}),
  })
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
      target,
    ])
    return { image: target, agentVersion }
  } finally {
    await session.destroy()
  }
}

/**
 * An image with an environment's cached `exec` steps on top of `parent`, tagged by content so
 * it's built once. Secrets never exist here.
 */
export const environmentLayerTag = (parent: { id: string }, steps: string[]) =>
  `evalsuite-env:${sha256(JSON.stringify({ parent: parent.id, steps })).slice(0, 16)}`

export async function buildEnvironmentLayer(
  parent: { ref: string; id: string },
  steps: string[],
  signal?: AbortSignal,
): Promise<string> {
  const tag = environmentLayerTag(parent, steps)
  const exists = await docker(['image', 'inspect', '--format', '{{.Id}}', tag], { signal })
  if (exists.exitCode === 0) return tag
  const dockerfile = [
    `FROM ${parent.ref}`,
    'SHELL ["/bin/bash", "-c"]',
    `WORKDIR ${SANDBOX_ROOT}/${WORKSPACE_DIR}`,
    ...steps.map((s) => `RUN ${s.replace(/\n/g, ' \\\n  ')}`),
    `WORKDIR ${SANDBOX_ROOT}`,
  ].join('\n')
  const build = await docker(['build', '--quiet', '--tag', tag, '-'], { input: dockerfile, signal })
  if (build.exitCode !== 0) {
    throw new Error(
      `Building the environment layer (${steps.length} exec steps) failed:\n${tail(build.stderr)}`,
    )
  }
  return tag
}
