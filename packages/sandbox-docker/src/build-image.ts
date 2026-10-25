import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHarnessSandboxTemplate, type HarnessAgentAdapter } from '@ai-sdk/harness/agent'
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
import { contextFiles } from './dockerignore.ts'
import { type Engine, engineSpec } from './engine.ts'
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
import { shellQuote as q, run } from './process.ts'
import { createDockerSession } from './session.ts'

const PNPM_VERSION = '10.33.3'
/** npm before 11.6 (node:22 ships 10.9) can crash on circular peer sets (npm/cli#8261). */
const NPM_VERSION = '11.20.0'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

const slugify = (text: string, max: number) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')

/** The build context of reeval's base image, shipped in the package. */
export const DOCKER_CONTEXT = fileURLToPath(new URL('../docker', import.meta.url))

/**
 * How reeval bakes a harness into an image, beyond the build context and the adapter: bump it when
 * that changes what a baked image holds, so every image baked before rebuilds on its next use.
 */
const BAKE_REVISION = 2

/**
 * The image `docker({ from })` evals run in: `from` plus Node, git and the harness's CLI. The hash
 * covers the toolchain layer and {@link BAKE_REVISION} too, so a change to the sandbox user, paths
 * or how the harness is baked builds anew.
 */
export const harnessImageFor = (harness: BakedHarness, from: string) =>
  `${imageFor(harness)}-${slugify(from, 40) || 'image'}-${sha256(`${BAKE_REVISION}\0${toolchainDockerfile(from)}`).slice(0, 8)}`

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
  }
> = {
  cursor: {
    name: 'Cursor',
    cli: '@cursor/sdk',
    version: `node -p "'@cursor/sdk ' + require(process.env.HOME + '/.ai-sdk-harness/.harness-bootstrap/cursor-sdk/node_modules/@cursor/sdk/package.json').version"`,
    adapter: async () => (await import('@reeval/harness-cursor-sdk')).createCursorSdk(),
  },
  'claude-code': {
    name: 'Claude Code',
    cli: 'claude',
    adapter: async () => (await import('@ai-sdk/harness-claude-code')).createClaudeCode(),
  },
  antigravity: {
    name: 'Antigravity',
    cli: 'agy',
    adapter: async () => (await import('@reeval/harness-antigravity')).createAntigravity(),
  },
  opencode: {
    name: 'OpenCode',
    cli: 'opencode',
    adapter: async () =>
      (await import('@reeval/harness-opencode')).createOpenCode({
        auth: { GOOGLE_GENERATIVE_AI_API_KEY: 'unused' },
        model: 'google/unused',
      }),
  },
  goose: {
    name: 'Goose',
    cli: 'goose',
    adapter: async () =>
      (await import('@reeval/harness-goose')).createGoose({
        auth: { GOOGLE_API_KEY: 'unused' },
        model: 'unused',
      }),
  },
  pi: {
    name: 'pi',
    cli: 'pi',
    adapter: async () =>
      (await import('@reeval/harness-pi')).createPi({ auth: { GEMINI_API_KEY: 'unused' } }),
  },
  codex: {
    name: 'Codex',
    cli: 'codex',
    adapter: async () =>
      (await import('@reeval/harness-codex')).createCodex({
        auth: { OPENAI_API_KEY: 'unused' },
      }),
  },
  fx: {
    name: 'fx',
    cli: 'fx',
    adapter: async () =>
      (await import('@reeval/harness-fx')).createFx({
        auth: { AI_GATEWAY_API_KEY: 'unused' },
        model: 'unused/unused',
      }),
  },
  'grok-build': {
    name: 'Grok Build',
    cli: 'grok',
    adapter: async () =>
      (await import('@reeval/harness-grok-build')).createGrokBuild({
        auth: { XAI_API_KEY: 'unused' },
        model: 'unused',
      }),
  },
}

/** Keeps the image's `PATH` in login shells, which Debian's `/etc/profile` resets. */
const profilePathScript = () =>
  readFileSync(join(DOCKER_CONTEXT, 'reeval-path.sh')).toString('base64')

/** `from` as it goes after `FROM`: one word, so it can't add a stage name or another instruction. */
function imageReference(from: string): string {
  if (!/^\S+$/.test(from)) {
    throw new Error(
      `docker({ from }) is an image reference without spaces or line breaks (got ${JSON.stringify(from)})`,
    )
  }
  return from
}

/**
 * A CLI's `--version` output as a label value in `docker commit --change`: its first line, without
 * quotes, backslashes or anything else that could end the value and add an instruction.
 */
export const versionLabel = (output: string) =>
  (output.split(/\r?\n/)[0] ?? '')
    .replace(/[^\w .+:/()@,~-]/g, '')
    .trim()
    .slice(0, 100) || 'unknown'

/**
 * Adds what the harness bridge needs to a Debian or Ubuntu based toolchain image: Node (copied
 * from the official image, so the base's own toolchain is untouched), pnpm, git, curl and bash.
 */
const toolchainDockerfile = (from: string) => `FROM ${imageReference(from)}
SHELL ["/bin/sh", "-c"]
RUN command -v apt-get >/dev/null || { echo "reeval needs a Debian or Ubuntu based image (glibc and apt-get)" >&2; exit 1; } \\
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
  && mkdir -p ${SANDBOX_ROOT}/${WORKSPACE_DIR} && chown -R ${SANDBOX_USER}: ${SANDBOX_ROOT} \\
  && mkdir -p /etc/profile.d \\
  && echo ${profilePathScript()} | base64 -d > /etc/profile.d/00-reeval-path.sh
ENV PATH=${SANDBOX_HOME}/.local/bin:$PATH
WORKDIR ${SANDBOX_ROOT}/${WORKSPACE_DIR}
`

const tail = (text: string) => text.trim().split('\n').slice(-15).join('\n')

const clipLine = (text: string, max = 300) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** Why a `docker build` failed, in a line: the failing step's exit, or BuildKit's (or buildah's) own error. */
function buildReason(error: string | null, engine?: Engine): string {
  if (!error) return `${engineSpec(engine).bin} build failed`
  const exit =
    /^process ".*" did not complete successfully: exit code: (\d+)$/s.exec(error) ??
    /^while running runtime: exit status (\d+)$/.exec(error)
  return exit ? `a RUN step exited ${exit[1]}` : clipLine(error.replace(/\s+/g, ' '))
}

/**
 * A failed `docker build --progress plain` as an {@link ImageBuildError}: `headline` then the
 * reason, the named cause, and the failing step's own last lines.
 */
function buildError(
  output: string,
  what: {
    stage: ImageStage
    ref: string
    headline: string
    log?: string | null
    engine?: Engine | undefined
  },
  reason?: (parsed: ReturnType<typeof parseBuildOutput>) => string | null,
  keep: (line: string) => boolean = () => true,
): ImageBuildError {
  const parsed = parseBuildOutput(output)
  const text = [parsed.error ?? '', ...parsed.output].join('\n')
  const cause = failureCause(text, parsed.exitCode)
  parsed.output = parsed.output.filter(keep)
  const why = reason?.(parsed) ?? buildReason(parsed.error, what.engine)
  return new ImageBuildError(
    failureMessage({
      headline: `${what.headline} failed: ${why}`,
      cause,
      output: parsed.output,
      log: what.log ?? null,
      ...(what.engine ? { engine: what.engine } : {}),
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

/** Every image reeval builds carries this label, so `reeval clean --images` can find what it left. */
const BUILT_BY = ['--label', `${LABEL.managed}=image`]

/**
 * Removes the images reeval built that nothing tags any more (a rebuild's old image) and the
 * intermediate `-base` tags of `from` builds. Returns how many it removed.
 */
export async function pruneImages(engine?: Engine): Promise<number> {
  const list = async (args: string[]) =>
    (await docker(['image', 'ls', ...args], { engine })).stdout
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
  const bases = (await list(['--format', '{{.Repository}}:{{.Tag}}', 'reeval-sandbox'])).filter(
    (ref) => ref.endsWith('-base'),
  )
  let removed = 0
  for (const ref of [...bases, ...new Set(dangling)]) {
    if ((await docker(['image', 'rm', ref], { engine }).catch(() => null))?.exitCode === 0) {
      removed++
    }
  }
  return removed
}

/** Docker's names for Node's architectures, as image indexes list platforms. */
const OCI_ARCH: Record<string, string> = {
  x64: 'amd64',
  arm64: 'arm64',
  arm: 'arm',
  ppc64: 'ppc64le',
}

/**
 * A registry digest for `from` without Docker's buildx: skopeo's, which is the same digest
 * buildx gives, or else this platform's manifest from `podman manifest inspect`.
 */
async function podmanRemoteDigest(
  from: string,
  signal?: AbortSignal,
): Promise<{ digest: string } | { error: string }> {
  const skopeo = await run('skopeo', ['inspect', '--format', '{{.Digest}}', `docker://${from}`], {
    ...(signal ? { signal } : {}),
  }).catch(() => null)
  const digest = skopeo?.exitCode === 0 ? skopeo.stdout.trim() : ''
  if (digest.startsWith('sha256:')) return { digest }
  const r = await docker(['manifest', 'inspect', from], { signal, engine: 'podman' }).catch(
    () => null,
  )
  if (r?.exitCode === 0) {
    const manifest = JSON.parse(r.stdout.toString('utf8')) as {
      manifests?: Array<{ digest?: string; platform?: { architecture?: string; os?: string } }>
    }
    const arch = OCI_ARCH[process.arch] ?? process.arch
    const own = manifest.manifests?.find(
      (m) => m.platform?.os === 'linux' && m.platform.architecture === arch,
    )?.digest
    if (own?.startsWith('sha256:')) return { digest: own }
  }
  const stderr = r?.stderr.trim() || skopeo?.stderr.trim() || ''
  return {
    error:
      stderr.replace(/^(?:Error|time="[^"]*" level=fatal msg=): ?/, '').replace(/\s+/g, ' ') ||
      `${from} doesn't resolve`,
  }
}

/**
 * What a `from` names now, without pulling: its registry digest, or for an image that's only
 * local, its id (`local`). `error` when neither resolves, e.g. a typo or no network.
 */
export async function resolveFrom(
  from: string,
  signal?: AbortSignal,
  engine?: Engine,
): Promise<{ digest: string; local: boolean } | { error: string }> {
  const pinned = /@(sha256:[0-9a-f]{64})$/.exec(from)?.[1]
  if (pinned) return { digest: pinned, local: false }
  let error: string | null = null
  if (engine === 'podman') {
    const remote = await podmanRemoteDigest(from, signal)
    if ('digest' in remote) return { digest: remote.digest, local: false }
    error = remote.error
  } else {
    const remote = await docker(
      ['buildx', 'imagetools', 'inspect', '--format', '{{json .Manifest.Digest}}', from],
      { signal },
    ).catch(() => null)
    const digest = remote?.exitCode === 0 ? JSON.parse(remote.stdout.toString('utf8').trim()) : null
    if (typeof digest === 'string' && digest.startsWith('sha256:')) return { digest, local: false }
    error =
      remote?.stderr
        .trim()
        .replace(/^ERROR: /, '')
        .replace(/\s+/g, ' ') || null
  }
  // An engine that can't inspect it leaves the registry's error as the answer.
  const local = await imageInfo(from, engine).catch(() => null)
  if (local) return { digest: local.id, local: true }
  return { error: error || `${from} doesn't resolve` }
}

/** Removes a tag or an image reeval replaced, unless something still uses it. */
const removeQuietly = async (ref: string, engine?: Engine) => {
  await docker(['image', 'rm', ref], { engine }).catch(() => {})
}

/**
 * The hash of reeval's base image build context and {@link BAKE_REVISION}, which its images carry
 * as a label.
 */
export function contextHash(): string {
  const hash = createHash('sha256')
  hash.update(`bake ${BAKE_REVISION}\0`)
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
 * image instead of reeval's Node image. `log` gets progress lines, `output` the build's full output
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
    /** Pull the base again even when it's cached: `reeval image build --force`. */
    pull?: boolean
    engine?: Engine
  },
): Promise<{ image: string; agentVersion: string }> {
  const { harness, from, signal, engine } = options
  // Built on the digest `from` names now, and labelled with it, so a moved tag is visible.
  const resolved = from ? await resolveFrom(from, signal, engine) : null
  const digest = resolved && 'digest' in resolved ? resolved.digest : null
  const pinned =
    from && digest && resolved && 'local' in resolved && !resolved.local && !from.includes('@')
      ? `${from}@${digest}`
      : from
  const bootstrap = BOOTSTRAPS[harness]
  const base = from ? `${harnessImageFor(harness, from)}-base` : BASE_IMAGE
  const target = from ? harnessImageFor(harness, from) : imageFor(harness)
  const previous = [
    (await imageInfo(target, engine))?.id,
    from ? null : (await imageInfo(base, engine))?.id,
  ]
  log(`Building ${base}${from ? ` from ${from}` : ''}`)
  const build = from
    ? await docker(
        [
          'build',
          '--progress',
          'plain',
          ...BUILT_BY,
          ...(options.pull ? ['--pull'] : []),
          '--tag',
          base,
          '-',
        ],
        { input: toolchainDockerfile(pinned ?? from), signal, engine },
      )
    : await docker(
        [
          'build',
          '--progress',
          'plain',
          ...BUILT_BY,
          '--build-arg',
          `NPM_VERSION=${NPM_VERSION}`,
          '--build-arg',
          `PNPM_VERSION=${PNPM_VERSION}`,
          '--tag',
          base,
          DOCKER_CONTEXT,
        ],
        { signal, engine },
      )
  const output = `${build.stdout.toString('utf8')}${build.stderr}`
  options.output?.write(output)
  if (build.exitCode !== 0) {
    throw buildError(
      output,
      {
        stage: from ? 'from' : 'harness',
        ref: target,
        headline: from
          ? `Building the toolchain layer FROM ${from}`
          : "Building reeval's base image",
        log: options.output?.path ?? null,
        engine,
      },
      (parsed) => parsed.output.find((l) => l.startsWith('reeval needs a Debian')) ?? null,
    )
  }

  log(`Installing the ${bootstrap.name} harness bootstrap`)
  // As the sandbox user, so the bootstrap lands in the home the agent runs with.
  const session = await createDockerSession({
    image: base,
    lifetimeMs: 30 * 60_000,
    ...(signal ? { abortSignal: signal } : {}),
    ...(engine ? { engine } : {}),
  })
  let agentVersion: string
  try {
    agentVersion = await bake(session, bootstrap)
    log(`${bootstrap.name} ${bootstrap.version ? '' : 'CLI '}${agentVersion}`)
    await dockerOk(
      [
        'commit',
        '--change',
        `LABEL ${LABEL.agentVersion}="${agentVersion}" ${LABEL.harness}="${harnessLabel(harness)}"${from ? (digest ? ` ${LABEL.fromDigest}="${digest}"` : '') : ` ${LABEL.context}="${contextHash()}"`}`,
        '--change',
        `WORKDIR ${SANDBOX_ROOT}`,
        // Not the bootstrap's user: Dockerfiles `FROM ${REEVAL_BASE}` build as root.
        '--change',
        'USER root',
        '--change',
        'ENTRYPOINT []',
        '--change',
        'CMD ["bash"]',
        session.id,
        target,
      ],
      { engine },
    )
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
        ...(engine ? { engine } : {}),
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
  if (from) await removeQuietly(base, engine)
  const now = (await imageInfo(target, engine))?.id
  for (const id of previous) if (id && id !== now) await removeQuietly(id, engine)
  return { image: target, agentVersion }
}

/** Runs the harness bootstrap in `session` and returns the CLI version it installed. */
async function bake(
  session: Awaited<ReturnType<typeof createDockerSession>>,
  bootstrap: (typeof BOOTSTRAPS)[BakedHarness],
): Promise<string> {
  const template = await createHarnessSandboxTemplate({
    harnesses: [await bootstrap.adapter()],
    sandboxConfig: { workDir: WORKSPACE_DIR },
  })
  await template?.prepare({ session })
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
  return versionLabel(version.stdout.trim())
}

/** One `docker({ install })` command, killed after `timeoutMs` when set. */
export type InstallStep = { run: string; timeoutMs?: number }

/**
 * The image `docker({ install })` runs in: the commands on top of `parent`, tagged by the parent's
 * id and the exact list, so it's built once. Secrets and the workspace never exist here.
 */
export const installLayerTag = (parent: { id: string }, steps: InstallStep[]) =>
  `reeval-install:${sha256(JSON.stringify({ parent: parent.id, steps })).slice(0, 16)}`

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
      `echo "reeval: install ${n}: "${label}`,
      `${run} || { code=$?; echo "reeval: install ${n} exited $code: "${label} >&2; exit $code; }`,
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
  options: { signal?: AbortSignal; output?: BuildOutput; engine?: Engine } = {},
): Promise<string> {
  const { signal, engine } = options
  const tag = installLayerTag(parent, steps)
  const exists = await docker(['image', 'inspect', '--format', '{{.Created}}', tag], {
    signal,
    engine,
  })
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
    `RUN echo ${encoded} | base64 -d > /tmp/reeval-install.sh \\`,
    `  && if id -u ${SANDBOX_USER} >/dev/null 2>&1; then export HOME="${home}"; fi \\`,
    '  && bash /tmp/reeval-install.sh && rm /tmp/reeval-install.sh \\',
    `  && { ! id -u ${SANDBOX_USER} >/dev/null 2>&1 || find "$HOME" -xdev ! -user ${SANDBOX_USER} -exec chown -h ${SANDBOX_USER}: {} +; }`,
    `WORKDIR ${SANDBOX_ROOT}`,
  ].join('\n')
  const build = await docker(['build', '--progress', 'plain', ...BUILT_BY, '--tag', tag, '-'], {
    input: dockerfile,
    signal,
    engine,
  })
  const output = `${build.stdout.toString('utf8')}${build.stderr}`
  options.output?.write(`${script}\n${dockerfile}\n\n${output}`)
  if (build.exitCode !== 0) {
    const failed = /reeval: install (\d+\/\d+) exited (\d+): (.*)/.exec(output)
    const count = `${steps.length} command${steps.length === 1 ? '' : 's'}`
    throw buildError(
      output,
      {
        stage: 'install',
        ref: tag,
        headline: `Building the install layer (${count})`,
        log: options.output?.path ?? null,
        engine,
      },
      () =>
        failed ? `install ${failed[1]} exited ${failed[2]}: ${clipLine(failed[3] ?? '')}` : null,
      (line) => !line.startsWith('reeval: install '),
    )
  }
  return tag
}

/** Where a plugin layer leaves each built plugin, by its build's hash. */
export const PLUGIN_BUILDS_DIR = `${SANDBOX_ROOT}/plugin-builds`

/**
 * The sha256 of a plugin build's source as the layer gets it: every file `docker build` sends from
 * `context` (less `.dockerignore` and `.git`), with its executable bit or symlink target.
 */
export function sourceTreeHash(context: string): string {
  const hash = createHash('sha256')
  for (const path of contextFiles(context, null)) {
    if (path === '.git' || path.startsWith('.git/')) continue
    const full = join(context, path)
    const stat = lstatSync(full)
    hash.update(`${path}\0${stat.mode & 0o111 ? 'x' : '-'}\0`)
    hash.update(stat.isSymbolicLink() ? readlinkSync(full) : readFileSync(full))
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** One plugin's build: its source, where it runs and what of it is kept, hashed by {@link pluginBuildKey}. */
export type PluginBuildSpec = {
  /** The whole source on the host: the repository, the package or the local directory. */
  context: string
  /** The source's commit, or null for an npm package or a local directory. */
  commit: string | null
  /** {@link sourceTreeHash} of `context`. */
  tree: string
  /** The plugin's directory in the source, kept after the build; `.` for the root. */
  path: string
  /** Where the commands run, relative to the source's root. */
  cwd: string
  steps: InstallStep[]
}

/** The hash a plugin layer's tag and directory carry: commit, tree and build. */
export const pluginBuildKey = (b: PluginBuildSpec) =>
  sha256(JSON.stringify({ commit: b.commit, tree: b.tree, path: b.path, cwd: b.cwd, run: b.steps }))

/** The image a plugin build makes on `parent`: the parent's id, then the build's hash. */
export const pluginLayerTag = (parent: { id: string }, b: PluginBuildSpec) =>
  `reeval-plugin:${parent.id.replace(/^sha256:/, '').slice(0, 12)}-${pluginBuildKey(b).slice(0, 16)}`

/** Where a plugin layer leaves the plugin's directory. */
export const pluginBuildDir = (b: PluginBuildSpec) =>
  `${PLUGIN_BUILDS_DIR}/${pluginBuildKey(b).slice(0, 16)}`

/** The line a plugin build's script fails with when its `cwd` isn't in the source. */
const noCwd = (cwd: string) => `reeval: build cwd ${cwd} isn't a directory in the source`

/**
 * A plugin build's commands as one script, run from `cwd` under `src` (the source's root), stopping
 * at the first failure as an install script does, or before any when `cwd` isn't there.
 */
export const pluginBuildScript = (b: Pick<PluginBuildSpec, 'cwd' | 'steps'>, src: string) =>
  installScript(b.steps)
    .replaceAll('reeval: install ', 'reeval: build ')
    .replace(/^cd \/\n/, `cd ${q(`${src}/${b.cwd}`)} || { echo ${q(noCwd(b.cwd))} >&2; exit 1; }\n`)

/**
 * Builds a plugin's layer on `parent` if it's missing: the whole source, then its commands from
 * `cwd` as root with the sandbox user's home as HOME (as an install layer runs), keeping only the
 * plugin's directory at {@link pluginBuildDir}. Secrets and the workspace never exist here.
 */
export async function buildPluginLayer(
  parent: { ref: string; id: string },
  b: PluginBuildSpec,
  options: { name: string; signal?: AbortSignal; output?: BuildOutput; engine?: Engine },
): Promise<string> {
  const { signal, engine } = options
  const tag = pluginLayerTag(parent, b)
  const exists = await docker(['image', 'inspect', '--format', '{{.Created}}', tag], {
    signal,
    engine,
  })
  if (exists.exitCode === 0) return tag
  const src = '/tmp/reeval-plugin-src'
  const script = pluginBuildScript(b, src)
  const encoded = Buffer.from(script).toString('base64')
  const home = `$(getent passwd ${SANDBOX_USER} | cut -d: -f6)`
  const dir = pluginBuildDir(b)
  const dockerfile = [
    `FROM ${parent.ref}`,
    'USER root',
    `COPY . ${src}`,
    // The tag's tree hash leaves `.git` out, so the commands mustn't see it either.
    `RUN rm -rf ${src}/.git && echo ${encoded} | base64 -d > /tmp/reeval-plugin-build.sh \\`,
    `  && if id -u ${SANDBOX_USER} >/dev/null 2>&1; then export HOME="${home}"; fi \\`,
    '  && bash /tmp/reeval-plugin-build.sh && rm /tmp/reeval-plugin-build.sh \\',
    `  && mkdir -p ${dir} && cp -a ${q(`${src}/${b.path}`)}/. ${dir}/ && rm -rf ${src} ${dir}/.git \\`,
    `  && chmod -R a+rX ${dir} \\`,
    `  && { ! id -u ${SANDBOX_USER} >/dev/null 2>&1 || find "$HOME" -xdev ! -user ${SANDBOX_USER} -exec chown -h ${SANDBOX_USER}: {} +; }`,
    `WORKDIR ${SANDBOX_ROOT}`,
  ].join('\n')
  const build = await docker(
    ['build', '--progress', 'plain', ...BUILT_BY, '--tag', tag, '-f', '-', b.context],
    { input: dockerfile, signal, engine },
  )
  const output = `${build.stdout.toString('utf8')}${build.stderr}`
  options.output?.write(`${script}\n${dockerfile}\n\n${output}`)
  if (build.exitCode !== 0) {
    const failed = /reeval: build (\d+\/\d+) exited (\d+): (.*)/.exec(output)
    const missing = output.includes(noCwd(b.cwd))
    throw buildError(
      output,
      {
        stage: 'plugin',
        ref: tag,
        headline: `Building ${options.name}`,
        log: options.output?.path ?? null,
        engine,
      },
      () =>
        missing
          ? noCwd(b.cwd).slice('reeval: '.length)
          : failed
            ? `build ${failed[1]} exited ${failed[2]}: ${clipLine(failed[3] ?? '')}`
            : null,
      (line) => !line.startsWith('reeval: build '),
    )
  }
  return tag
}

/** The build arg a Dockerfile can start `FROM` to layer on reeval's sandbox image. */
export const REEVAL_BASE_ARG = 'REEVAL_BASE'

/** Whether the Dockerfile starts from reeval's sandbox image, which then has to exist first. */
export const usesReevalBase = (dockerfile: string) =>
  new RegExp(`\\$\\{?${REEVAL_BASE_ARG}\\b`).test(readFileSync(dockerfile, 'utf8'))

/**
 * The tag of a `docker({ dockerfile })` build for a harness: a hash of the Dockerfile, every file
 * of its build context (its directory, less `.dockerignore`) and, for a Dockerfile `FROM
 * ${REEVAL_BASE}`, the id of the harness's image it names, so an edit to any of them, or a rebuilt reeval
 * image, builds anew. `reevalBase` is that id (null when it isn't built).
 */
export function dockerfileTag(
  dockerfile: string,
  harness: BakedHarness,
  reevalBase: string | null = null,
): { tag: string; sha256: string } {
  const context = dirname(dockerfile)
  const base = usesReevalBase(dockerfile) ? `${imageFor(harness)}@${reevalBase ?? 'unbuilt'}` : ''
  const hash = createHash('sha256').update(`${REEVAL_BASE_ARG}=${base}\0`)
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
  return { tag: `reeval-dockerfile:${name || 'image'}-${digest.slice(0, 16)}`, sha256: digest }
}

/**
 * Builds the user's Dockerfile with plain `docker build` (so Docker's layer cache applies), from
 * its directory, with `REEVAL_BASE` set to the harness's sandbox image (whose id is `reevalBase`).
 * Rebuilds even when the tag exists with `force`, as `reeval image build` does, and then removes the
 * image the tag pointed at before. `name` is the path failures name.
 */
export async function buildDockerfile(
  dockerfile: string,
  options: {
    harness: BakedHarness
    reevalBase?: string | null
    name?: string
    signal?: AbortSignal
    output?: BuildOutput
    force?: boolean
    /** Pull its `FROM` again: `reeval image build --force`. */
    pull?: boolean
    engine?: Engine
  },
): Promise<string> {
  const { harness, signal, engine } = options
  const { tag } = dockerfileTag(dockerfile, harness, options.reevalBase ?? null)
  const previous = (await imageInfo(tag, engine))?.id
  if (previous && !options.force) return tag
  const build = await docker(
    [
      'build',
      '--progress',
      'plain',
      ...BUILT_BY,
      ...(options.pull ? ['--pull'] : []),
      '--file',
      dockerfile,
      '--build-arg',
      `${REEVAL_BASE_ARG}=${imageFor(harness)}`,
      '--tag',
      tag,
      dirname(dockerfile),
    ],
    { signal, engine },
  )
  const output = `${build.stdout.toString('utf8')}${build.stderr}`
  options.output?.write(output)
  if (build.exitCode !== 0) {
    throw buildError(output, {
      stage: 'dockerfile',
      ref: tag,
      headline: `Building ${options.name ?? dockerfile}`,
      log: options.output?.path ?? null,
      engine,
    })
  }
  const now = (await imageInfo(tag, engine))?.id
  if (previous && previous !== now) await removeQuietly(previous, engine)
  return tag
}
