// File-name slugs, browser-safe, so a reader that folds a record names its evals as the host did.
import { sha256Hex } from './sha256.ts'

/** Lower-case letters, digits and dashes, for use inside file names. */
export const slugify = (text: string, max: number) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')

/** Readable, unique directory name for an eval id. */
export function evalSlug(id: string): string {
  return `${slugify(id, 60) || 'eval'}-${sha256Hex(id).slice(0, 6)}`
}
