import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ES's one resource locator: every other module finds ES's own files (package.json, dist/,
// docker/, assets/) and requires through here. The build rewrites the inlined packages'
// `new URL(…, import.meta.url)` lookups to `ownFileURL` and fails on any other import.meta.url.
// This file is directly in src/, and the build puts every chunk directly in dist/, so the
// package is one level up either way.
const HERE = import.meta.url

/**
 * Whether ES runs as a single-file executable (`bun build --compile`), where modules live in a
 * virtual filesystem. It finds its own files beside the executable, in a package's layout.
 */
export const COMPILED = /^file:\/\/\/(?:\$bunfs|[A-Za-z]:\/~BUN)\//.test(HERE)

export const PACKAGE_DIR = COMPILED
  ? dirname(process.execPath)
  : fileURLToPath(new URL('../', HERE))
export const DIST_DIR = join(PACKAGE_DIR, 'dist')

/** One of ES's own files, by its path in the package (`docker`, `dist/studio-app`, …). */
export const ownFile = (path: string): string => join(PACKAGE_DIR, path)

/** `ownFile` as a URL; a trailing `/` stays, so the URL resolves names inside the directory. */
export const ownFileURL = (path: string): URL => pathToFileURL(ownFile(path))

/** `require` as seen from ES's package: its dependencies and Node's built-ins. */
export const ownRequire = createRequire(ownFile('package.json'))

const manifest = JSON.parse(readFileSync(ownFile('package.json'), 'utf8'))

/** This ES's package name and version, from its package.json. */
export const PACKAGE_NAME: string = manifest.name
export const PACKAGE_VERSION: string = manifest.version

/** The names a project imports ES by: the package's, and the monorepo's alias for it. */
export const PACKAGE_NAMES: readonly string[] = [...new Set([PACKAGE_NAME, 'evalsuite'])]

/**
 * This build of ES: its version and its code's mtime. npm gives every installed file the same
 * mtime, so the version tells releases apart; a rebuild moves the mtime.
 */
export const BUILD_ID = `${PACKAGE_VERSION}:${statSync(COMPILED ? process.execPath : fileURLToPath(HERE)).mtimeMs}`

/**
 * The command that runs the `es` at `cli` (a package's `dist/cli.js`) with `args`: Node with
 * `nodeArgs` and the file, or, compiled, this executable, which runs its own code.
 */
export function esCommand(
  cli: string,
  args: readonly string[],
  nodeArgs: readonly string[] = [],
): [string, ...string[]] {
  return COMPILED ? [process.execPath, ...args] : [process.execPath, ...nodeArgs, cli, ...args]
}
