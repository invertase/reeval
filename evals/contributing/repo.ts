import { execFileSync } from 'node:child_process'
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
