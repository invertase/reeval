import { createHash, randomBytes } from 'node:crypto'
import { relative, sep } from 'node:path'

export const relativeFile = (root: string, file: string) =>
  relative(root, file).split(sep).join('/')

/** Stable id: the file, the enclosing group names and the eval name. */
export const evalId = (file: string, path: string[]) => [file, ...path].join(' › ')

export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')

export const recordFileName = (id: string) => `${sha256(id).slice(0, 16)}.json`

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz'

/** `20260924T152700Z-3f9k2m7q`: sorts by start time; 40 random bits keep concurrent runs apart. */
export function newRunId(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  const bytes = randomBytes(5)
  let bits = 0n
  for (const b of bytes) bits = (bits << 8n) | BigInt(b)
  let suffix = ''
  for (let i = 0; i < 8; i++) {
    suffix = CROCKFORD[Number(bits & 31n)] + suffix
    bits >>= 5n
  }
  return `${stamp}-${suffix}`
}

export const RUN_ID = /^(\d{4})(\d{2})\d{2}T\d{6}Z?-[0-9a-z]+$/

/** `runs/<yyyy>/<mm>/<runId>`, from the runId's UTC date. */
export function runDir(runId: string): string {
  const match = RUN_ID.exec(runId)
  if (!match) throw new Error(`Not a run id: ${runId}`)
  return `runs/${match[1]}/${match[2]}/${runId}`
}

/** Readable, unique directory name for an eval id. */
export function evalSlug(id: string): string {
  const readable = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return `${readable || 'eval'}-${sha256(id).slice(0, 6)}`
}
