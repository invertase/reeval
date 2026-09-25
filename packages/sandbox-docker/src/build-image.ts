import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareSandboxForHarness } from '@ai-sdk/harness/agent'
import { createCursor } from '@ai-sdk/harness-cursor'
import { docker, dockerOk } from './docker-cli.ts'
import {
  BASE_IMAGE,
  DEFAULT_IMAGE,
  HARNESS_CURSOR_VERSION,
  LABEL,
  SANDBOX_ROOT,
  WORKSPACE_DIR,
} from './image.ts'

import { createDockerSession } from './session.ts'

const PNPM_VERSION = '10.33.3'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

const slugify = (text: string, max: number) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')

/** The build context of ES's base image, shipped in the package. */
export const DOCKER_CONTEXT = fileURLToPath(new URL('../docker', import.meta.url))

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
    : await docker(['build', '--quiet', '--tag', base, DOCKER_CONTEXT], { signal })
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

/** One `docker({ install })` command, killed after `timeoutMs` when set. */
export type InstallStep = { run: string; timeoutMs?: number }

/**
 * The image `docker({ install })` runs in: the commands on top of `parent`, tagged by the parent's
 * id and the exact list, so it's built once. Secrets and the workspace never exist here.
 */
export const installLayerTag = (parent: { id: string }, steps: InstallStep[]) =>
  `evalsuite-install:${sha256(JSON.stringify({ parent: parent.id, steps })).slice(0, 16)}`

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/** The commands as one bash script: in order, from `/`, stopping at the first that fails. */
export function installScript(steps: InstallStep[]): string {
  const lines = ['cd /']
  for (const [i, step] of steps.entries()) {
    const n = `${i + 1}/${steps.length}`
    const run = step.timeoutMs
      ? `timeout --kill-after=10 ${Math.ceil(step.timeoutMs / 1000)} bash -c ${q(step.run)}`
      : `bash -c ${q(step.run)}`
    const label = q(step.run.split('\n')[0] ?? '')
    lines.push(
      `echo "es: install ${n}: "${label}`,
      `${run} || { code=$?; echo "es: install ${n} exited $code: "${label} >&2; exit $code; }`,
    )
  }
  return `${lines.join('\n')}\n`
}

/** Builds the install layer if it's missing. `log` gets the build's output, for a log file. */
export async function buildInstallLayer(
  parent: { ref: string; id: string },
  steps: InstallStep[],
  options: { signal?: AbortSignal; log?: (output: string) => void } = {},
): Promise<string> {
  const { signal } = options
  const tag = installLayerTag(parent, steps)
  const exists = await docker(['image', 'inspect', '--format', '{{.Id}}', tag], { signal })
  if (exists.exitCode === 0) return tag
  const script = installScript(steps)
  // Base64, so no command's quoting or newlines can break the Dockerfile.
  const encoded = Buffer.from(script).toString('base64')
  const dockerfile = [
    `FROM ${parent.ref}`,
    `RUN echo ${encoded} | base64 -d > /tmp/es-install.sh && bash /tmp/es-install.sh && rm /tmp/es-install.sh`,
    `WORKDIR ${SANDBOX_ROOT}`,
  ].join('\n')
  const build = await docker(['build', '--progress', 'plain', '--tag', tag, '-'], {
    input: dockerfile,
    signal,
  })
  options.log?.(`${script}\n${dockerfile}\n\n${build.stdout.toString('utf8')}${build.stderr}`)
  if (build.exitCode !== 0) {
    const failed = /es: install \d+\/\d+ exited \d+: .*/.exec(build.stderr)?.[0]
    throw new Error(
      `Building the install layer (${steps.length} commands) failed${failed ? `: ${failed.replace(/^es: /, '')}` : ''}\n${tail(build.stderr)}`,
    )
  }
  return tag
}

/** The build arg a Dockerfile can start `FROM` to layer on ES's sandbox image. */
export const ES_BASE_ARG = 'ES_BASE'

/**
 * `.dockerignore` rules as Docker reads them: paths from the context root, `*`, `?` and `**`
 * globs, a pattern that matches a directory excludes what's in it, `!` re-includes, and the last
 * matching rule wins.
 */
export function dockerignoreMatcher(text: string): (path: string) => boolean {
  const rules = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const negate = line.startsWith('!')
      const body = (negate ? line.slice(1) : line)
        .trim()
        .replace(/^(?:\.?\/)+/, '')
        .replace(/\/+$/, '')
      let re = ''
      for (let i = 0; i < body.length; i++) {
        const c = body[i] as string
        if (c === '*' && body[i + 1] === '*') {
          i++
          if (body[i + 1] === '/') {
            i++
            re += '(?:.*/)?'
          } else re += '.*'
        } else if (c === '*') re += '[^/]*'
        else if (c === '?') re += '[^/]'
        else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      }
      return { negate, re: new RegExp(`^${re}$`) }
    })
  return (path) => {
    const parts = path.split('/')
    const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join('/'))
    let excluded = false
    for (const rule of rules) {
      if (prefixes.some((p) => rule.re.test(p))) excluded = !rule.negate
    }
    return excluded
  }
}

/** Files in the build context that `docker build` would send, sorted, relative to `context`. */
export function contextFiles(context: string, dockerfile: string): string[] {
  const own = [`${dockerfile}.dockerignore`, join(context, '.dockerignore')].find(existsSync)
  const ignored = dockerignoreMatcher(own ? readFileSync(own, 'utf8') : '')
  const always = new Set([relative(context, dockerfile), '.dockerignore'])
  const files: string[] = []
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(context, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (ignored(path) && !always.has(path)) continue
      if (entry.isDirectory()) walk(path)
      else files.push(path)
    }
  }
  walk('')
  return files.sort()
}

/**
 * The tag of a `docker({ dockerfile })` build: a hash of the Dockerfile, every file of its build
 * context (its directory, less `.dockerignore`) and ES's base image, so an edit to any of them
 * builds anew.
 */
export function dockerfileTag(dockerfile: string): { tag: string; sha256: string } {
  const context = dirname(dockerfile)
  const hash = createHash('sha256').update(`${ES_BASE_ARG}=${DEFAULT_IMAGE}\0`)
  for (const path of contextFiles(context, dockerfile)) {
    const full = join(context, path)
    const stat = lstatSync(full)
    hash.update(`${path}\0${stat.mode & 0o111 ? 'x' : '-'}\0`)
    hash.update(stat.isSymbolicLink() ? readlinkSync(full) : readFileSync(full))
    hash.update('\0')
  }
  const digest = hash.digest('hex')
  const name = slugify(
    basename(dockerfile) === 'Dockerfile' ? basename(context) : basename(dockerfile),
    40,
  )
  return { tag: `evalsuite-dockerfile:${name || 'image'}-${digest.slice(0, 16)}`, sha256: digest }
}

/**
 * Builds the user's Dockerfile with plain `docker build` (so Docker's layer cache applies), from
 * its directory, with `ES_BASE` set to ES's sandbox image. Rebuilds even when the tag exists
 * with `force`, as `es image build` does.
 */
export async function buildDockerfile(
  dockerfile: string,
  options: { signal?: AbortSignal; log?: (output: string) => void; force?: boolean } = {},
): Promise<string> {
  const { signal } = options
  const { tag } = dockerfileTag(dockerfile)
  if (!options.force) {
    const exists = await docker(['image', 'inspect', '--format', '{{.Id}}', tag], { signal })
    if (exists.exitCode === 0) return tag
  }
  const build = await docker(
    [
      'build',
      '--progress',
      'plain',
      '--file',
      dockerfile,
      '--build-arg',
      `${ES_BASE_ARG}=${DEFAULT_IMAGE}`,
      '--tag',
      tag,
      dirname(dockerfile),
    ],
    { signal },
  )
  options.log?.(`${build.stdout.toString('utf8')}${build.stderr}`)
  if (build.exitCode !== 0) {
    throw new Error(`Building ${dockerfile} failed:\n${tail(build.stderr)}`)
  }
  return tag
}
