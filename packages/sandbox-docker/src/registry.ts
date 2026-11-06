import { createHash } from 'node:crypto'
import type { Layer } from './build-image.ts'
import { docker } from './docker-cli.ts'
import { type Engine, engineSpec } from './engine.ts'

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
 * so one machine's push is another's pull only when they'd have built the same thing.
 */
export function registryRef(registry: string, layer: Layer): string {
  const at = layer.ref.lastIndexOf(':')
  const repository = layer.ref.slice(0, at)
  const tag = layer.ref.slice(at + 1)
  const pinned =
    layer.key === layer.ref
      ? tag
      : `${tag}-${createHash('sha256').update(layer.key).digest('hex').slice(0, 12)}`
  return `${registry.replace(/\/+$/, '')}/${repository}:${pinned}`
}

const firstLine = (stderr: string) =>
  stderr
    .trim()
    .split('\n')
    .filter(Boolean)
    .at(-1)
    ?.replace(/^Error(?: response from daemon)?: /, '') ?? ''

/**
 * Pulls `layer` from `registry` and tags it as its local ref. `pulled: false` with the engine's
 * reason when the registry doesn't have it or can't be reached: the caller builds it instead.
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
  const tag = await docker(['tag', remote, layer.ref], { engine, signal })
  await docker(['image', 'rm', remote], { engine }).catch(() => {})
  if (tag.exitCode !== 0) {
    return { pulled: false, remote, reason: firstLine(tag.stderr) || `exit ${tag.exitCode}` }
  }
  return { pulled: true, remote }
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
