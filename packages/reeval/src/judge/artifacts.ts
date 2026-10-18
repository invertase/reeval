import { sha256 } from '../ids.ts'
import { isObjectLike } from '../object.ts'
import type {
  Capture,
  JudgeArtifactRef,
  JudgeFilePart,
  JudgeJsonState,
  JudgeState,
} from '../types.ts'

/** A capture handle: a name plus the file the attempt wrote. */
export function isCaptureHandle(value: unknown): value is Capture {
  return (
    isObjectLike(value) &&
    typeof value.name === 'string' &&
    isObjectLike(value.file) &&
    typeof value.file.path === 'string'
  )
}

/** The first `artifacts` value that isn't `true` or a list of capture handles or names. */
export function badJudgeArtifacts(artifacts: unknown): string | undefined {
  if (artifacts === undefined || artifacts === true) return undefined
  if (!Array.isArray(artifacts)) {
    return `must be true or a list of capture handles or names (got ${JSON.stringify(artifacts)})`
  }
  for (const item of artifacts) {
    if (typeof item === 'string' && item.trim()) continue
    if (isCaptureHandle(item)) continue
    return `must be true or a list of capture handles or names (got ${JSON.stringify(item)})`
  }
  return undefined
}

export type ResolvedJudgeArtifact = JudgeArtifactRef & { data: Uint8Array }

const nameOf = (item: Capture | string) => (typeof item === 'string' ? item.trim() : item.name)

/**
 * Resolves call `artifacts` (capture handles or their names, or `true` for every capture so far,
 * in capture order) to PNG bytes this attempt captured. Unknown names throw: a mistake in the
 * call, before the provider is asked.
 */
export function resolveJudgeArtifacts(
  artifacts: true | Array<Capture | string> | undefined,
  blobs: Map<string, Buffer>,
): ResolvedJudgeArtifact[] {
  const items = artifacts === true ? [...blobs.keys()] : artifacts
  if (!items?.length) return []
  return items.map((item) => {
    const name = nameOf(item)
    const data = blobs.get(name)
    if (!data) {
      throw new Error(
        `c.judge() artifacts names a capture this attempt doesn't have: ${JSON.stringify(name)}`,
      )
    }
    return {
      name,
      path: `artifacts/${name}.png`,
      sha256: sha256(data),
      bytes: data.byteLength,
      mediaType: 'image/png',
      data,
    }
  })
}

export const filePartsOf = (resolved: readonly ResolvedJudgeArtifact[]): JudgeFilePart[] =>
  resolved.map((a) => ({ type: 'file', mediaType: a.mediaType, data: a.data }))

export const artifactRefsOf = (resolved: readonly ResolvedJudgeArtifact[]): JudgeArtifactRef[] =>
  resolved.map(({ data: _data, ...ref }) => ref)

/**
 * JSON-only state is a plain object, as TypeSafe and other JSON judges read it.
 * File parts are an ordered decide-state array: one JSON part, then each capture.
 */
export function decideState(json: JudgeJsonState, files: readonly JudgeFilePart[]): JudgeState {
  if (files.length === 0) return json
  return [{ type: 'json', value: json }, ...files]
}
