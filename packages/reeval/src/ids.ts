import { createHash, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'

export const relativeFile = (root: string, file: string) =>
  relative(root, file).split(sep).join('/')

/**
 * `path` from the current directory, as reeval prints it. The current directory is always spelled
 * physically (macOS's `/var/…` is `/private/var/…`), so `path` is too, through its nearest part
 * that exists.
 */
export function fromCwd(path: string): string {
  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      const parent = dirname(p)
      return parent === p ? p : join(real(parent), basename(p))
    }
  }
  return relativeFile(process.cwd(), real(path))
}

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

/** `20260924T152700Z`, the part of a run id that orders runs. */
export const RUN_STAMP_LENGTH = 16

/**
 * `20260924T152700Z_009763c_elliot-hesp_k3f9`. Sorting by name sorts by UTC start time; the SHA
 * and author keep runs from different people or branches apart, and the random suffix keeps
 * runs that start in the same second anywhere (other projects, CI shards) apart.
 */
export function newRunId(
  start: Date,
  sha: string | null,
  author: string,
  suffix = randomSuffix(4),
): string {
  const stamp = start
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  return `${stamp}_${sha ? sha.slice(0, 7) : 'nogit'}_${author}_${suffix}`
}

export { RUN_ID } from './view/paths.ts'

/** Readable, unique directory name for an eval id. */
export function evalSlug(id: string): string {
  return `${slugify(id, 60) || 'eval'}-${sha256(id).slice(0, 6)}`
}
