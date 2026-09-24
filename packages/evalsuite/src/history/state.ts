import { randomBytes } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { git } from '../git.ts'
import { sha256 } from '../ids.ts'
import type { Environment, RunRecord } from './types.ts'

const LOCKFILES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'pubspec.lock',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'Podfile.lock',
  'gradle.lockfile',
]

/** Dependency state: lockfiles in the project root and, if different, the repo root. */
export async function lockfiles(root: string): Promise<Array<{ path: string; sha256: string }>> {
  const top = await git(root, ['rev-parse', '--show-toplevel'])
  const dirs = [root]
  const repo = top.code === 0 ? top.stdout.toString('utf8').trim() : null
  if (repo && repo !== root) dirs.push(repo)
  const found: Array<{ path: string; sha256: string }> = []
  for (const dir of dirs) {
    for (const name of LOCKFILES) {
      const bytes = await readFile(join(dir, name)).catch(() => null)
      if (!bytes) continue
      const path = relative(root, join(dir, name)).split(sep).join('/')
      found.push({ path, sha256: sha256(bytes) })
    }
  }
  return found
}

/** Above this, a dirty run keeps the patch's hash but not the patch. */
export const WORKTREE_PATCH_LIMIT = 5 * 1024 * 1024

/**
 * Uncommitted changes, tracked and untracked (ignored files excluded), as one binary patch that
 * `git apply` recreates on top of HEAD. Built through a temporary index so the user's index is
 * never touched. ES's own output (`ignore`, absolute paths) is left out.
 */
export async function worktreePatch(root: string, ignore: string[]): Promise<Buffer | null> {
  const topResult = await git(root, ['rev-parse', '--show-toplevel'])
  if (topResult.code !== 0) return null
  const top = topResult.stdout.toString('utf8').trim()
  const index = join(tmpdir(), `es-index-${process.pid}-${randomBytes(4).toString('hex')}`)
  const env = { GIT_INDEX_FILE: index }
  const exclude = [
    ':(exclude,glob)**/.es/**',
    ...ignore.map((d) => `:(exclude)${relative(top, d).split(sep).join('/')}`),
  ]
  try {
    if ((await git(top, ['read-tree', 'HEAD'], { env })).code !== 0) return null
    if ((await git(top, ['add', '-A', '--', '.', ...exclude], { env })).code !== 0) return null
    const diff = await git(top, ['diff', '--cached', '--binary', 'HEAD'], { env })
    return diff.code === 0 && diff.stdout.length > 0 ? diff.stdout : null
  } finally {
    await rm(index, { force: true })
    await rm(`${index}.lock`, { force: true })
  }
}

const require = createRequire(import.meta.url)
const PACKAGES = ['ai', '@ai-sdk/harness', '@ai-sdk/harness-cursor', '@ai-sdk/google', 'vitest']

export function packageVersions(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of PACKAGES) {
    try {
      out[name] = require(`${name}/package.json`).version
    } catch {}
  }
  return out
}

/** Moves whenever the code that builds and scores the judge prompt could have changed. */
export function judgeVersion(es: string, packages: Record<string, string>, model: string): string {
  const adapter = model.startsWith('google/') ? packages['@ai-sdk/google'] : packages.ai
  return sha256(JSON.stringify({ es, ai: packages.ai, adapter, model })).slice(0, 12)
}

/** What a rerun from the same commit, patch and image still can't pin down. */
export function reproducibilityNotes(record: Omit<RunRecord, 'reproducibility'>): string[] {
  const env: Environment = record.environment
  const notes = [
    'Agents sample their output, so a rerun of the same state can take a different path.',
  ]
  if (env.harness.kind !== 'fake') {
    notes.push(
      `The agent model (${env.harness.model ?? 'the harness default'}) is served by the provider and can change without notice${env.harness.resolvedModel ? '' : '; the harness does not report which version answered'}.`,
    )
  }
  if (!env.judge.model.startsWith('fake')) {
    notes.push(
      `The judge model (${env.judge.model}) can also change provider-side${env.judge.resolvedModels.length ? `; it reported ${env.judge.resolvedModels.join(', ')}` : ''}.`,
    )
  }
  if (record.config.sandbox === 'docker') {
    notes.push(
      'The sandbox has network access: web search, package registries and APIs can return different results on a rerun.',
    )
    if (env.image && env.image.repoDigests.length === 0) {
      notes.push(
        `The image ${env.image.ref} was built locally (id ${env.image.id.slice(0, 19)}…) and not pushed; rebuilding it reinstalls the agent CLI, so keep or push the image to reproduce exactly.`,
      )
    }
  }
  if (!record.git)
    notes.push('The project is not a git repository, so the code under test is not pinned.')
  else if (record.git.dirty && !record.git.worktreePatch) {
    notes.push(
      `The working tree was dirty and its changes weren't saved (${record.git.worktreePatchNote ?? 'no patch'}); only their hash is recorded.`,
    )
  }
  if (record.evals.some((e) => e.sourceHash)) {
    notes.push('Eval fingerprints hash each eval file, not the modules it imports.')
  }
  return notes
}
