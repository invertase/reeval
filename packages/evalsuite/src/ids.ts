import { createHash, randomBytes } from 'node:crypto'
import { relative, sep } from 'node:path'

export const relativeFile = (root: string, file: string) =>
  relative(root, file).split(sep).join('/')

/** Stable id: the file, the enclosing group names and the eval name. */
export const evalId = (file: string, path: string[]) => [file, ...path].join(' › ')

export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')

export const recordFileName = (id: string) => `${sha256(id).slice(0, 16)}.json`

/** `<cell key>#<n>`, e.g. `cursor:composer-2.5/with-skill/docker#2`. */
export const attemptId = (cellKey: string, n: number) => `${cellKey}#${n}`

/** Unique per attempt across the run: the eval id and the attempt id. */
export const attemptKey = (evalId: string, cellKey: string, n: number) =>
  `${evalId} # ${attemptId(cellKey, n)}`

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz'

export const randomSuffix = (length: number) =>
  [...randomBytes(length)].map((b) => CROCKFORD[b % 32]).join('')

/** Lower-case letters, digits and dashes, for use inside file names. */
export const slugify = (text: string, max: number) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')

/**
 * `20260924T152700Z_009763c_elliot-hesp`. Sorting by name sorts by UTC start time; the SHA and
 * author keep runs from different people or branches apart.
 */
export function newRunId(start: Date, sha: string | null, author: string): string {
  const stamp = start
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  return `${stamp}_${sha ? sha.slice(0, 7) : 'nogit'}_${author}`
}

export const RUN_ID = /^\d{8}T\d{6}Z_[0-9a-z]+_[0-9a-z-]+$/

/** Readable, unique directory name for an eval id. */
export function evalSlug(id: string): string {
  return `${slugify(id, 60) || 'eval'}-${sha256(id).slice(0, 6)}`
}
