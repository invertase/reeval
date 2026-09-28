import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Project, project } from '../helpers.ts'

/** `packages/reeval/test/`: fixture paths are relative to it. */
export const testDir = fileURLToPath(new URL('..', import.meta.url))

/**
 * Copies a committed fixture directory (e.g. `features/skills/git-ref`) into a fresh temp project
 * that resolves `reeval` to this package. `expected/` stays behind: it's what the test compares.
 */
export async function fixture(path: string): Promise<Project> {
  const p = await project(path.replace(/[^\w-]+/g, '-'), {})
  const from = join(testDir, path)
  cpSync(from, p.dir, {
    recursive: true,
    filter: (src) => src !== join(from, 'expected') && !src.startsWith(join(from, 'expected/')),
  })
  return p
}
