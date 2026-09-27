import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type HarnessAgentAdapter, prepareSandboxForHarness } from '@ai-sdk/harness/agent'
import {
  failureCause,
  failureMessage,
  ImageBuildError,
  type ImageStage,
  isTransient,
  outputTail,
  parseBuildOutput,
} from './build-failure.ts'
import { docker, dockerOk, imageInfo } from './docker-cli.ts'
import {
  BASE_IMAGE,
  type BakedHarness,
  harnessLabel,
  imageFor,
  LABEL,
  SANDBOX_HOME,
  SANDBOX_ROOT,
  SANDBOX_USER,
  WORKSPACE_DIR,
} from './image.ts'

import { shellQuote as q } from './process.ts'
import { createDockerSession } from './session.ts'

const PNPM_VERSION = '10.33.3'
/** npm before 11.6 (node:22 ships 10.9) can crash on circular peer sets (npm/cli#8261); the same as docker/Dockerfile's. */
const NPM_VERSION = '11.20.0'

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

/** The image `docker({ from })` evals run in: `from` plus Node, git and the harness's CLI. */
export const harnessImageFor = (harness: BakedHarness, from: string) =>
  `${imageFor(harness)}-${slugify(from, 40) || 'image'}-${sha256(from).slice(0, 8)}`

/**
 * How each harness's CLI gets into an image: its adapter's bootstrap, and the binary it leaves
 * (or, for an adapter without one, a command that prints what it installed).
 */
const BOOTSTRAPS: Record<
  BakedHarness,
  {
    name: string
    cli: string
    version?: string
    adapter: () => Promise<HarnessAgentAdapter>
    /** What the CLI would otherwise install into the sandbox on every start, baked in once. */
    warm?: () => Promise<string>
  }
> = {
  cursor: {
    name: 'Cursor',
    cli: '@cursor/sdk',
    version: `node -p "'@cursor/sdk ' + require(process.env.HOME + '/.ai-sdk-harness/.harness-bootstrap/cursor-sdk/node_modules/@cursor/sdk/package.json').version"`,
    adapter: async () => (await import('@evalsuite/harness-cursor-sdk')).createCursorSdk(),
  },
  'claude-code': {
    name: 'Claude Code',
    cli: 'claude',
    adapter: async () => (await import('@ai-sdk/harness-claude-code')).createClaudeCode(),
  },
  antigravity: {
    name: 'Antigravity',
    cli: 'agy',
    adapter: async () => (await import('@evalsuite/harness-antigravity')).createAntigravity(),
  },
  opencode: {
    name: 'OpenCode',
    cli: 'opencode',
    // The bootstrap only installs the CLI; the key is never used.
    adapter: async () =>
      (await import('@evalsuite/harness-opencode')).createOpenCode({
        auth: { GOOGLE_GENERATIVE_AI_API_KEY: 'unused' },
      }),
    // Its plugin runtime (63 MB from npm), which it installs into its config directory at start.
    warm: async () => (await import('@evalsuite/harness-opencode')).OPENCODE_WARM_COMMAND,
  },
  goose: {
    name: 'Goose',
    cli: 'goose',
    // The bootstrap only installs the CLI; the key and model are never used.
    adapter: async () =>
      (await import('@evalsuite/harness-goose')).createGoose({
        auth: { GOOGLE_API_KEY: 'unused' },
        model: 'unused',
      }),
  },
  pi: {
    name: 'pi',
    cli: 'pi',
    // The bootstrap only installs the CLI; the key is never used.
    adapter: async () =>
      (await import('@evalsuite/harness-pi')).createPi({ auth: { GEMINI_API_KEY: 'unused' } }),
  },
  codex: {
    name: 'Codex',
    cli: 'codex',
    // The bootstrap only installs the CLI; the key is never used.
    adapter: async () =>
      (await import('@evalsuite/harness-codex')).createCodex({
        auth: { OPENAI_API_KEY: 'unused' },
      }),
  },
}

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
  && npm install --global npm@${NPM_VERSION} \\
  && npm install --global pnpm@${PNPM_VERSION} \\
  && { id -u ${SANDBOX_USER} >/dev/null 2>&1 \\
    || useradd --create-home --shell /bin/bash --uid 10001 --user-group ${SANDBOX_USER} 2>/dev/null \\
    || useradd --create-home --shell /bin/bash --user-group ${SANDBOX_USER}; } \\
  && mkdir -p ${SANDBOX_ROOT}/${WORKSPACE_DIR} && chown -R ${SANDBOX_USER}: ${SANDBOX_ROOT}
ENV PATH=${SANDBOX_HOME}/.local/bin:$PATH
WORKDIR ${SANDBOX_ROOT}/${WORKSPACE_DIR}
`

const tail = (text: string) => text.trim().split('\n').slice(-15).join('\n')

const clipLine = (text: string, max = 300) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** Why a `docker build` failed, in a line: the failing step's exit, or BuildKit's own error. */
function buildReason(error: string | null): string {
  if (!error) return 'docker build failed'
  const exit = /^process ".*" did not complete successfully: exit code: (\d+)$/s.exec(error)
  return exit ? `a RUN step exited ${exit[1]}` : clipLine(error.replace(/\s+/g, ' '))
}

/**
 * A failed `docker build --progress plain` as an {@link ImageBuildError}: `headline` then the
 * reason, the named cause, and the failing step's own last lines.
 */
function buildError(
  output: string,
  what: { stage: ImageStage; ref: string; headline: string; log?: string | null },
  reason?: (parsed: ReturnType<typeof parseBuildOutput>) => string | null,
  keep: (line: string) => boolean = () => true,
): ImageBuildError {
  const parsed = parseBuildOutput(output)
  const text = [parsed.error ?? '', ...parsed.output].join('\n')
  const cause = failureCause(text, parsed.exitCode)
  parsed.output = parsed.output.filter(keep)
  const why = reason?.(parsed) ?? buildReason(parsed.error)
  return new ImageBuildError(
    failureMessage({
      headline: `${what.headline} failed: ${why}`,
      cause,
      output: parsed.output,
      log: what.log ?? null,
    }),
    {
      stage: what.stage,
      ref: what.ref,
      transient: isTransient(text),
      cause,
      log: what.log ?? null,
    },
  )
}

/** Every image ES builds carries this label, so `es clean --images` can find what it left. */
const BUILT_BY = ['--label', `${LABEL.managed}=image`]

/**
 * Removes the images ES built that nothing tags any more (a rebuild's old image) and the
 * intermediate `-base` tags of `from` builds. Returns how many it removed.
 */
export async function pruneImages(): Promise<number> {
  const list = async (args: string[]) =>
    (await docker(['image', 'ls', ...args])).stdout
      .toString('utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  const dangling = [
    ...(await list([
      '-q',
      '--filter',
      'dangling=true',
      '--filter',
      `label=${LABEL.managed}=image`,
    ])),
    ...(await list(['-q', '--filter', 'dangling=true', '--filter', `label=${LABEL.harness}`])),
  ]
  const bases = (await list(['--format', '{{.Repository}}:{{.Tag}}', 'evalsuite-sandbox'])).filter(
    (ref) => ref.endsWith('-base'),
  )
  let removed = 0
  for (const ref of [...bases, ...new Set(dangling)]) {
    if ((await docker(['image', 'rm', ref]).catch(() => null))?.exitCode === 0) removed++
  }
  return removed
}

/** Removes a tag or an image ES replaced, unless something still uses it. */
const removeQuietly = async (ref: string) => {
  await docker(['image', 'rm', ref]).catch(() => {})
}

/** The hash of ES's base image build context, which its images carry as a label. */
export function contextHash(): string {
  const hash = createHash('sha256')
  for (const path of contextFiles(DOCKER_CONTEXT, join(DOCKER_CONTEXT, 'Dockerfile'))) {
    hash.update(`${path}\0`)
    hash.update(readFileSync(join(DOCKER_CONTEXT, path)))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}

/**
 * Bakes a harness's bootstrap (which installs its agent's CLI) into an image, so the image tag
 * pins the CLI build. Rebuild after bumping the adapter. With `from`, the base is that toolchain
 * image instead of ES's Node image. `log` gets progress lines, `output` the build's full output
 * (for a log file, whose path failures name). The previous image under the tag, and the
 * intermediate `-base` tag of a `from` build, are removed once the new one is committed.
 */
export async function buildImage(
  log: (line: string) => void,
  options: {
    harness: BakedHarness
    from?: string
    signal?: AbortSignal
    output?: BuildOutput
  },
): Promise<{ image: string; agentVersion: string }> {
  const { harness, from, signal } = options
  const bootstrap = BOOTSTRAPS[harness]
  const base = from ? `${harnessImageFor(harness, from)}-base` : BASE_IMAGE
  const target = from ? harnessImageFor(harness, from) : imageFor(harness)
  const previous = [(await imageInfo(target))?.id, from ? null : (await imageInfo(base))?.id]
  log(`Building ${base}${from ? ` from ${from}` : ''}`)
  const build = from
    ? await docker(['build', '--progress', 'plain', ...BUILT_BY, '--tag', base, '-'], {
        input: toolchainDockerfile(from),
        signal,
      })
    : await docker(['build', '--progress', 'plain', ...BUILT_BY, '--tag', base, DOCKER_CONTEXT], {
        signal,
      })
  const output = `${build.stdout.toString('utf8')}${build.stderr}`
  options.output?.write(output)
  if (build.exitCode !== 0) {
    throw buildError(
      output,
      {
        stage: from ? 'from' : 'harness',
        ref: target,
        headline: from ? `Building the toolchain layer FROM ${from}` : "Building ES's base image",
        log: options.output?.path ?? null,
      },
      (parsed) => parsed.output.find((l) => l.startsWith('ES needs a Debian')) ?? null,
    )
  }

  log(`Installing the ${bootstrap.name} harness bootstrap`)
  // As the sandbox user, so the bootstrap lands in the home the agent runs with.
  const session = await createDockerSession({
    image: base,
    lifetimeMs: 30 * 60_000,
    ...(signal ? { abortSignal: signal } : {}),
  })
  let agentVersion: string
  try {
    agentVersion = await bake(session, bootstrap)
    log(`${bootstrap.name} ${bootstrap.version ? '' : 'CLI '}${agentVersion}`)
    await dockerOk([
      'commit',
      '--change',
      `LABEL ${LABEL.agentVersion}="${agentVersion}" ${LABEL.harness}="${harnessLabel(harness)}"${from ? '' : ` ${LABEL.context}="${contextHash()}"`}`,
      '--change',
      `WORKDIR ${SANDBOX_ROOT}`,
      // Not the bootstrap's user: Dockerfiles `FROM ${ES_BASE}` build as root.
      '--change',
      'USER root',
      '--change',
      'ENTRYPOINT []',
      '--change',
      'CMD ["bash"]',
      session.id,
      target,
    ])
  } catch (error) {
    if (signal?.aborted || error instanceof ImageBuildError) throw error
    const [first = '', ...rest] = (error as Error).message.split('\n')
    const cause = failureCause((error as Error).message, null)
    options.output?.write(`${output}\n${(error as Error).message}\n`)
    throw new ImageBuildError(
      failureMessage({
        headline: `Baking the ${bootstrap.name} CLI onto ${from ?? BASE_IMAGE} failed: ${clipLine(first)}`,
        cause,
        output: outputTail(rest.join('\n')),
        log: options.output?.path ?? null,
      }),
      {
        stage: 'harness',
        ref: target,
        transient: isTransient((error as Error).message),
        cause,
        log: options.output?.path ?? null,
      },
    )
  } finally {
    await session.destroy()
  }
  if (from) await removeQuietly(base)
  const now = (await imageInfo(target))?.id
  for (const id of previous) if (id && id !== now) await removeQuietly(id)
  return { image: target, agentVersion }
}

/** Runs the harness bootstrap in `session` and returns the CLI version it installed. */
async function bake(
  session: Awaited<ReturnType<typeof createDockerSession>>,
  bootstrap: (typeof BOOTSTRAPS)[BakedHarness],
): Promise<string> {
  await prepareSandboxForHarness({
    session,
    harnesses: [await bootstrap.adapter()],
    sandboxConfig: { workDir: WORKSPACE_DIR },
  })
  if (bootstrap.warm) {
    const warmed = await session.run({ command: await bootstrap.warm() })
    if (warmed.exitCode !== 0) {
      throw new Error(`Warming the ${bootstrap.name} image failed:\n${tail(warmed.stderr)}`)
    }
  }
  let probe = bootstrap.version
  if (!probe) {
    const found = await session.run({
      command: `find "$HOME/.ai-sdk-harness" -name ${bootstrap.cli} \\( -type f -o -type l \\) -perm -u+x | head -1`,
    })
    const bin = found.stdout.trim()
    if (!bin) throw new Error(`The harness bootstrap did not install the ${bootstrap.name} CLI`)
    probe = `'${bin}' --version`
  }
  const version = await session.run({ command: probe })
  if (bootstrap.version && version.exitCode !== 0) {
    throw new Error(
      `The harness bootstrap did not install ${bootstrap.cli}:\n${tail(version.stderr)}`,
    )
  }
  return version.stdout.trim() || 'unknown'
}

/** One `docker({ install })` command, killed after `timeoutMs` when set. */
export type InstallStep = { run: string; timeoutMs?: number }

/**
 * The image `docker({ install })` runs in: the commands on top of `parent`, tagged by the parent's
 * id and the exact list, so it's built once. Secrets and the workspace never exist here.
 */
export const installLayerTag = (parent: { id: string }, steps: InstallStep[]) =>
  `evalsuite-install:${sha256(JSON.stringify({ parent: parent.id, steps })).slice(0, 16)}`

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

/** Where a build's full output goes, and the path its failure names. */
export type BuildOutput = { write: (text: string) => void; path: string }

/** Builds the install layer if it's missing. `output` gets the build's output, for a log file. */
export async function buildInstallLayer(
  parent: { ref: string; id: string },
  steps: InstallStep[],
  options: { signal?: AbortSignal; output?: BuildOutput } = {},
): Promise<string> {
  const { signal } = options
  const tag = installLayerTag(parent, steps)
  const exists = await docker(['image', 'inspect', '--format', '{{.Id}}', tag], { signal })
  if (exists.exitCode === 0) return tag
  const script = installScript(steps)
  // Base64, so no command's quoting or newlines can break the Dockerfile.
  const encoded = Buffer.from(script).toString('base64')
  // As root, but with the sandbox user's home as HOME, so what an installer puts in `~` (uv, bun,
  // rustup…) is where the agent runs, and is then handed to that user.
  const home = `$(getent passwd ${SANDBOX_USER} | cut -d: -f6)`
  const dockerfile = [
    `FROM ${parent.ref}`,
    'USER root',
    `RUN echo ${encoded} | base64 -d > /tmp/es-install.sh \\`,
    `  && if id -u ${SANDBOX_USER} >/dev/null 2>&1; then export HOME="${home}"; fi \\`,
    '  && bash /tmp/es-install.sh && rm /tmp/es-install.sh \\',
    `  && { ! id -u ${SANDBOX_USER} >/dev/null 2>&1 || find "$HOME" -xdev ! -user ${SANDBOX_USER} -exec chown -h ${SANDBOX_USER}: {} +; }`,
    `WORKDIR ${SANDBOX_ROOT}`,
  ].join('\n')
  const build = await docker(['build', '--progress', 'plain', ...BUILT_BY, '--tag', tag, '-'], {
    input: dockerfile,
    signal,
  })
  const output = `${build.stdout.toString('utf8')}${build.stderr}`
  options.output?.write(`${script}\n${dockerfile}\n\n${output}`)
  if (build.exitCode !== 0) {
    const failed = /es: install (\d+\/\d+) exited (\d+): (.*)/.exec(output)
    const count = `${steps.length} command${steps.length === 1 ? '' : 's'}`
    throw buildError(
      output,
      {
        stage: 'install',
        ref: tag,
        headline: `Building the install layer (${count})`,
        log: options.output?.path ?? null,
      },
      () =>
        failed ? `install ${failed[1]} exited ${failed[2]}: ${clipLine(failed[3] ?? '')}` : null,
      (line) => !line.startsWith('es: install '),
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

/** Whether the Dockerfile starts from ES's sandbox image, which then has to exist first. */
export const usesEsBase = (dockerfile: string) =>
  new RegExp(`\\$\\{?${ES_BASE_ARG}\\b`).test(readFileSync(dockerfile, 'utf8'))

/**
 * The tag of a `docker({ dockerfile })` build for a harness: a hash of the Dockerfile, every file
 * of its build context (its directory, less `.dockerignore`) and, for a Dockerfile `FROM
 * ${ES_BASE}`, the id of the harness's image it names, so an edit to any of them, or a rebuilt ES
 * image, builds anew. `esBase` is that id (null when it isn't built).
 */
export function dockerfileTag(
  dockerfile: string,
  harness: BakedHarness,
  esBase: string | null = null,
): { tag: string; sha256: string } {
  const context = dirname(dockerfile)
  const base = usesEsBase(dockerfile) ? `${imageFor(harness)}@${esBase ?? 'unbuilt'}` : ''
  const hash = createHash('sha256').update(`${ES_BASE_ARG}=${base}\0`)
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
 * its directory, with `ES_BASE` set to the harness's sandbox image (whose id is `esBase`).
 * Rebuilds even when the tag exists with `force`, as `es image build` does, and then removes the
 * image the tag pointed at before. `name` is the path failures name.
 */
export async function buildDockerfile(
  dockerfile: string,
  options: {
    harness: BakedHarness
    esBase?: string | null
    name?: string
    signal?: AbortSignal
    output?: BuildOutput
    force?: boolean
  },
): Promise<string> {
  const { harness, signal } = options
  const { tag } = dockerfileTag(dockerfile, harness, options.esBase ?? null)
  const previous = (await imageInfo(tag))?.id
  if (previous && !options.force) return tag
  const build = await docker(
    [
      'build',
      '--progress',
      'plain',
      ...BUILT_BY,
      '--file',
      dockerfile,
      '--build-arg',
      `${ES_BASE_ARG}=${imageFor(harness)}`,
      '--tag',
      tag,
      dirname(dockerfile),
    ],
    { signal },
  )
  const output = `${build.stdout.toString('utf8')}${build.stderr}`
  options.output?.write(output)
  if (build.exitCode !== 0) {
    throw buildError(output, {
      stage: 'dockerfile',
      ref: tag,
      headline: `Building ${options.name ?? dockerfile}`,
      log: options.output?.path ?? null,
    })
  }
  const now = (await imageInfo(tag))?.id
  if (previous && previous !== now) await removeQuietly(previous)
  return tag
}
