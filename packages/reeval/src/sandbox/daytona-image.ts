// The image a `daytona({ image | from | dockerfile | install })` attempt starts from, as one
// Dockerfile Daytona builds: reeval's toolchain on the recipe's base, the harness's bootstrap
// rendered as steps that run as the sandbox user, the install commands, and a copy of the sandbox
// user's home that a shared machine's slots restore. Daytona builds it into a snapshot, keyed by
// content, or on every create when the key can't make snapshots.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, posix } from 'node:path'
import {
  type DockerSession,
  dockerfileTag,
  imageFor,
  installLayerLines,
  installScript,
  isBakedHarness,
  keepHomeCopy,
  NODE_IMAGE,
  REEVAL_BASE_ARG,
  SANDBOX_HOME,
  SANDBOX_ROOT,
  SANDBOX_USER,
  toolchainDockerfile,
} from '@reeval/sandbox-docker'
import { shellQuote as q } from '@reeval/sandbox-docker/process'
import type { DaytonaSandboxDescriptor, HarnessDescriptor } from '../types.ts'
import { harnessBake } from './harness-install.ts'
import { imageRecipeKey, installSteps, type ResolveDigest, registryResolver } from './recipe.ts'

/** Bumped when the generated Dockerfile's shape changes, so every snapshot is built anew. */
const REVISION = 1

/** The stage a `FROM ${REEVAL_BASE}` Dockerfile starts from: reeval's toolchain and the harness. */
const BASE_STAGE = 'reeval-base'

/** What `daytona()` builds an attempt's image from. */
export type DaytonaImage = {
  /** The Dockerfile Daytona builds. */
  dockerfile: string
  /** The directory its `COPY` sources are in: a user Dockerfile's own. */
  contextDir?: string
  /** Its content key: the recipe, what its bases name now, the harness, and the Dockerfile. */
  key: string
  /** The snapshot's name: `<prefix>-img-<first 12 hex of the key>`. */
  name: string
  /** The harness install's label, whose home copy the image keeps; unset with nothing baked. */
  homeLabel?: string
  /** Whether the image has the harness, so an attempt doesn't install it. */
  harnessBaked: boolean
  /** Why the key couldn't pin a base by digest, so the build may pull something newer. */
  unpinned?: { ref: string; reason: string }
}

/**
 * The commands and files `harness`'s bootstrap runs and writes in a fresh sandbox, as a script run
 * as the sandbox user, or null when there's nothing to install. It replays the bootstrap against a
 * session that records instead of running: every command succeeds with no output, and the home
 * is the sandbox user's. A probe that runs a binary it looked up runs `/bin/true` in the build,
 * so an install that left no CLI fails in the attempt, not the build.
 */
export async function harnessScript(harness: HarnessDescriptor): Promise<string | null> {
  const bake = harnessBake(harness)
  if (!bake) return null
  const lines = [
    'set -e',
    `export HOME=${SANDBOX_HOME} USER=${SANDBOX_USER} NPM_CONFIG_PREFIX=${SANDBOX_HOME}/.local NPM_CONFIG_UPDATE_NOTIFIER=false`,
    `export PATH=${SANDBOX_HOME}/.local/bin:$PATH`,
    `mkdir -p ${SANDBOX_HOME}/.local/bin`,
  ]
  const run = async (o: {
    command: string
    env?: Record<string, string>
    workingDirectory?: string
  }) => {
    if (o.command === 'printf "%s" "$HOME"')
      return { exitCode: 0, stdout: SANDBOX_HOME, stderr: '' }
    const env = Object.entries(o.env ?? {}).map(([k, v]) => `${k}=${q(v)}`)
    const cwd = o.workingDirectory ?? SANDBOX_ROOT
    lines.push(
      `(cd ${q(cwd)} && ${env.length ? `env ${env.join(' ')} ` : ''}bash -c ${q(o.command)})`,
    )
    // A bootstrap that looks for the binary it installed finds one, and probes it in the build.
    const found = /^find "\$HOME\/\.ai-sdk-harness" -name /.test(o.command)
    return { exitCode: 0, stdout: found ? '/bin/true' : '', stderr: '' }
  }
  const writeTextFile = async (o: { path: string; content: string }) => {
    const encoded = Buffer.from(o.content).toString('base64')
    lines.push(`mkdir -p ${q(posix.dirname(o.path))} && echo ${encoded} | base64 -d > ${q(o.path)}`)
  }
  const session = {
    defaultWorkingDirectory: SANDBOX_ROOT,
    run,
    readTextFile: async () => null,
    writeTextFile,
  } as unknown as DockerSession
  await bake.install(session)
  return `${lines.join('\n')}\n`
}

/** Under the 64 KiB line that older Dockerfile parsers stop at. */
const CHUNK = 48 * 1024

/** The Dockerfile lines that run `script` as the sandbox user, in base64 across lines of `CHUNK`. */
function asSandboxUser(script: string): string[] {
  const encoded = Buffer.from(script).toString('base64')
  const lines = [`USER ${SANDBOX_USER}`]
  for (let i = 0; i < encoded.length; i += CHUNK) {
    lines.push(`RUN echo ${encoded.slice(i, i + CHUNK)} >> /tmp/reeval-harness.b64`)
  }
  lines.push(
    'RUN base64 -d /tmp/reeval-harness.b64 > /tmp/reeval-harness.sh \\',
    '  && bash /tmp/reeval-harness.sh && rm /tmp/reeval-harness.sh /tmp/reeval-harness.b64',
    'USER root',
  )
  return lines
}

/** A Dockerfile's text with its parser directives (`# syntax=…`) apart, since they must stay first. */
function directives(text: string): { head: string[]; body: string } {
  const lines = text.split('\n')
  const head: string[] = []
  while (lines.length && /^#\s*[a-z]+\s*=/i.test(lines[0] ?? '')) head.push(lines.shift() as string)
  return { head, body: lines.join('\n') }
}

/** `FROM ${REEVAL_BASE}` (and `COPY --from=`) on the base stage, which Daytona can't pull by tag. */
function onBaseStage(body: string, harnessImage: string | undefined): string {
  const arg = new RegExp(`\\$\\{?${REEVAL_BASE_ARG}\\}?(?![\\w])`, 'g')
  return body
    .split('\n')
    .map((line) => {
      if (!/^\s*(FROM|COPY|ADD)\b/i.test(line)) return line
      const out = line.replace(arg, BASE_STAGE)
      return harnessImage ? out.split(harnessImage).join(BASE_STAGE) : out
    })
    .join('\n')
}

/**
 * The image `sandbox` describes for `harness`, or null for Daytona's default snapshot. `resolve`
 * names what a base is now, for the key.
 */
export async function daytonaImage(
  sandbox: DaytonaSandboxDescriptor,
  harness: HarnessDescriptor,
  o: { resolve?: ResolveDigest; signal?: AbortSignal } = {},
): Promise<DaytonaImage | null> {
  const { image, from, dockerfile, install } = sandbox
  if (image === undefined && from === undefined && dockerfile === undefined && !install) return null
  const bake = harnessBake(harness)
  const script = image === undefined ? await harnessScript(harness) : null
  const harnessLines = script ? asSandboxUser(script) : []
  const baked = isBakedHarness(harness.kind) ? harness.kind : undefined
  const asked = new Map<string, ReturnType<ResolveDigest>>()
  const outer = o.resolve ?? registryResolver()
  const resolve: ResolveDigest = (ref, signal) => {
    const known = asked.get(ref) ?? outer(ref, signal)
    asked.set(ref, known)
    return known
  }
  const pins: { ref: string; digest: string }[] = []
  let unpinned: DaytonaImage['unpinned']
  const pin = async (ref: string) => {
    const now = await resolve(ref, o.signal)
    if ('error' in now) unpinned ??= { ref, reason: now.error }
    else pins.push({ ref, digest: now.digest })
    return 'error' in now ? '' : now.digest
  }
  let recipeKey: string
  if (image !== undefined) recipeKey = `image:${image}@${await pin(image)}`
  else {
    const named = baked
      ? await imageRecipeKey({ from, dockerfile, install }, baked, { resolve, signal: o.signal })
      : undefined
    if (named && 'unresolved' in named) unpinned = named.unresolved
    const fromPin = from !== undefined ? await pin(from) : ''
    recipeKey =
      named && 'key' in named
        ? named.key
        : dockerfile !== undefined
          ? `dockerfile:${dockerfileTag(dockerfile, baked ?? 'cursor').tag}`
          : `from:${from ?? NODE_IMAGE}@${fromPin}`
  }
  const pinned = (ref: string) => {
    const pin = pins.find((p) => p.ref === ref)
    return pin && !ref.includes('@') ? `${ref}@${pin.digest}` : ref
  }

  const lines: string[] = []
  let contextDir: string | undefined
  if (image !== undefined) {
    lines.push(`FROM ${pinned(image)}`)
  } else if (dockerfile !== undefined) {
    contextDir = dirname(dockerfile)
    const { head, body } = directives(readFileSync(dockerfile, 'utf8').replace(/\r\n/g, '\n'))
    const reevalBase = new RegExp(`\\$\\{?${REEVAL_BASE_ARG}\\b`).test(body)
    const harnessImage = baked ? imageFor(baked) : undefined
    const onBase = reevalBase || (harnessImage !== undefined && body.includes(harnessImage))
    lines.push(...head)
    if (onBase) {
      const base = toolchainDockerfile(NODE_IMAGE).trimEnd().split('\n')
      lines.push(`${base[0]} AS ${BASE_STAGE}`, ...base.slice(1), ...harnessLines, '')
      lines.push(onBaseStage(body, harnessImage).trimEnd())
    } else {
      lines.push(body.trimEnd(), 'USER root')
      lines.push(...toolchainDockerfile(NODE_IMAGE).trimEnd().split('\n').slice(1), ...harnessLines)
    }
  } else {
    lines.push(
      ...toolchainDockerfile(pinned(from ?? NODE_IMAGE))
        .trimEnd()
        .split('\n'),
    )
    lines.push(...harnessLines)
  }
  if (install) lines.push(...installLayerLines(installScript(installSteps({ install }))))
  const homeLabel = script && bake ? bake.label : undefined
  if (homeLabel) lines.push('USER root', `RUN ${keepHomeCopy(homeLabel)}`)
  lines.push('USER root', `WORKDIR ${SANDBOX_ROOT}`, 'ENTRYPOINT ["sleep", "infinity"]', '')
  const text = lines.join('\n')
  const size = sandbox.size ?? 'medium'
  const key = createHash('sha256')
    .update(JSON.stringify([REVISION, 'daytona', recipeKey, size, text]))
    .digest('hex')
  return {
    dockerfile: text,
    ...(contextDir !== undefined && { contextDir }),
    key,
    name: `${sandbox.prefix}-img-${key.slice(0, 12)}`,
    ...(homeLabel && { homeLabel }),
    harnessBaked: image !== undefined || script !== null || bake === null,
    ...(unpinned && { unpinned }),
  }
}
