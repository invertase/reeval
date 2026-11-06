import { createHash } from 'node:crypto'
import { type Layer, PLATFORM } from './build-image.ts'
import { docker, imageInfo } from './docker-cli.ts'
import { type Engine, engineSpec } from './engine.ts'
import { LABEL } from './image.ts'

type Options = { engine?: Engine | undefined; signal?: AbortSignal | undefined }

/**
 * What's wrong with a registry prefix, or null: a registry host (with an optional port) and an
 * optional path, as `docker push` names one, without a scheme, tag or digest.
 */
export function registryProblem(registry: string): string | null {
  if (/^[a-z0-9.-]+(:\d+)?(\/[a-z0-9]+([._-]+[a-z0-9]+)*)*\/?$/.test(registry)) return null
  return `--registry is a registry and an optional path, such as ghcr.io/acme/reeval or localhost:5000/reeval, in lowercase without a scheme, tag or digest (got ${JSON.stringify(registry)})`
}

/**
 * Where a layer goes in `registry`: its repository under the prefix, with its tag, plus its content
 * key's hash where the tag alone doesn't pin what's in it (reeval's own image and a `from` image),
 * and the platform, so one machine's push is another's pull only when they'd have built the same
 * thing for the same architecture.
 */
export function registryRef(registry: string, layer: Layer, platform = PLATFORM): string {
  const at = layer.ref.lastIndexOf(':')
  const repository = layer.ref.slice(0, at)
  const tag = layer.ref.slice(at + 1)
  const pinned =
    layer.key === layer.ref
      ? tag
      : `${tag}-${createHash('sha256').update(layer.key).digest('hex').slice(0, 12)}`
  return `${registry.replace(/\/+$/, '')}/${repository}:${pinned}-${platform.replaceAll('/', '-')}`
}

const firstLine = (stderr: string) =>
  stderr
    .trim()
    .split('\n')
    .filter(Boolean)
    .at(-1)
    ?.replace(/^Error(?: response from daemon)?: /, '') ?? ''

/**
 * Pulls `layer` from `registry` and tags it as its local ref, once it's checked: its
 * {@link LABEL.key} must be the layer's key and its platform {@link PLATFORM}. `pulled: false` with
 * the reason when the registry doesn't have it, can't be reached or has another image under the
 * ref: the caller builds it instead. The registry is otherwise trusted: anyone who can push to it
 * chooses what a matching tag holds.
 */
export async function pullLayer(
  registry: string,
  layer: Layer,
  options: Options = {},
): Promise<{ pulled: true; remote: string } | { pulled: false; remote: string; reason: string }> {
  const { engine, signal } = options
  const remote = registryRef(registry, layer)
  const pull = await docker(['pull', '--quiet', remote], { engine, signal }).catch(
    (error: Error) => ({ exitCode: 1, stderr: error.message }),
  )
  if (pull.exitCode !== 0) {
    return { pulled: false, remote, reason: firstLine(pull.stderr) || `exit ${pull.exitCode}` }
  }
  try {
    const info = await imageInfo(remote, engine).catch(() => null)
    const key = info?.labels[LABEL.key]
    if (key !== layer.key) {
      return {
        pulled: false,
        remote,
        reason: key
          ? `its ${LABEL.key} label is ${key}, not ${layer.key}`
          : `it has no ${LABEL.key} label`,
      }
    }
    if (info?.platform !== PLATFORM) {
      return {
        pulled: false,
        remote,
        reason: `it's for ${info?.platform ?? 'an unknown platform'}, not ${PLATFORM}`,
      }
    }
    const tag = await docker(['tag', remote, layer.ref], { engine, signal })
    if (tag.exitCode !== 0) {
      return { pulled: false, remote, reason: firstLine(tag.stderr) || `exit ${tag.exitCode}` }
    }
    return { pulled: true, remote }
  } finally {
    await docker(['image', 'rm', remote], { engine }).catch(() => {})
  }
}

/** Pushes `layer` to `registry` under {@link registryRef}, which it returns. */
export async function pushLayer(
  registry: string,
  layer: Layer,
  options: Options = {},
): Promise<string> {
  const { engine, signal } = options
  const { bin } = engineSpec(engine)
  const remote = registryRef(registry, layer)
  const tag = await docker(['tag', layer.ref, remote], { engine, signal })
  if (tag.exitCode !== 0) {
    throw new Error(`${bin} tag ${layer.ref} ${remote} failed: ${firstLine(tag.stderr)}`)
  }
  try {
    const push = await docker(['push', remote], { engine, signal })
    if (push.exitCode !== 0) {
      throw new Error(`${bin} push ${remote} failed: ${firstLine(push.stderr)}`)
    }
  } finally {
    await docker(['image', 'rm', remote], { engine }).catch(() => {})
  }
  return remote
}
