import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This checkout of reeval: each task starts from one of its commits. */
export const REPO = fileURLToPath(new URL('../..', import.meta.url))

const git = (...args: string[]) =>
  execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

/** A file as it was at `ref`. */
export const show = (ref: string, path: string) => git('show', `${ref}:${path}`)

/** The files as they were at `ref`, by path. */
export const showAll = (ref: string, paths: string[]) =>
  Object.fromEntries(paths.map((p) => [p, show(ref, p)]))

/** From `base` to `head` as a patch `git apply` takes, leaving out `exclude`. */
export const patchOf = (base: string, head: string, exclude: string[]) =>
  git('diff', '--binary', base, head, '--', '.', ...exclude.map((p) => `:(exclude)${p}`))

/**
 * The files branch `ref` changes, as its change leaves them on top of commit `at`: its diff from
 * where it left HEAD's history, applied to `at`'s copies. The diff has no context lines, so it
 * applies to an older file whose neighboring lines have since been rewrapped.
 */
export function changedOnto(at: string, ref: string): Record<string, string> {
  const base = git('merge-base', ref, 'HEAD').trim()
  const paths = git('diff', '--name-only', base, ref).trim().split('\n')
  const dir = mkdtempSync(join(tmpdir(), 'reeval-changed-'))
  try {
    for (const path of paths) {
      if (!git('ls-tree', '--name-only', at, '--', path).trim()) continue
      mkdirSync(join(dir, dirname(path)), { recursive: true })
      writeFileSync(join(dir, path), show(at, path))
    }
    execFileSync('git', ['apply', '--unidiff-zero', '-'], {
      cwd: dir,
      input: git('diff', '-U0', base, ref),
    })
    return Object.fromEntries(paths.map((p) => [p, readFileSync(join(dir, p), 'utf8')]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
