import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// reeval's one resource locator: every other module finds reeval's own files (package.json, dist/,
// docker/, assets/) and requires through here. The build rewrites the inlined packages'
// `new URL(…, import.meta.url)` lookups to `ownFileURL` and fails on any other import.meta.url.
// This file is directly in src/, and the build puts every chunk directly in dist/, so the
// package is one level up either way.
const HERE = import.meta.url

/**
 * Whether reeval runs as a single-file executable (`bun build --compile`, scripts/bun-compile.mjs).
 * Its own files are embedded in it, in a package's layout, at the root of Bun's virtual
 * filesystem, beside the bundled code.
 */
export const COMPILED = /^file:\/\/\/(?:\$bunfs|[A-Za-z]:\/~BUN)\//.test(HERE)

export const PACKAGE_DIR = fileURLToPath(new URL(COMPILED ? './' : '../', HERE))
export const DIST_DIR = join(PACKAGE_DIR, 'dist')

/** One of reeval's own files, by its path in the package (`docker`, `dist/studio-app`, …). */
export const ownFile = (path: string): string => join(PACKAGE_DIR, path)

/**
 * `ownFile` as a URL; a trailing `/` stays, so the URL resolves names inside the directory.
 * Compiled, a directory is `ownDir`'s copy on disk.
 */
export function ownFileURL(path: string): URL {
  const file = ownFile(path)
  if (!COMPILED || !statSync(file, { throwIfNoEntry: false })?.isDirectory())
    return pathToFileURL(file)
  return pathToFileURL(ownDir(path) + (/[\\/]$/.test(path) ? sep : ''))
}

const extracted = new Map<string, string>()

/**
 * One of reeval's own directories, as a real one on disk. Compiled, it's copied out of the
 * executable once, to a cache directory named for its contents: `docker build` and copying the
 * studio app need real files.
 */
export function ownDir(path: string): string {
  const from = ownFile(path)
  if (!COMPILED) return from
  const known = extracted.get(from)
  if (known) return known
  const files = readdirSync(from, { recursive: true, encoding: 'utf8' })
    .filter((f) => statSync(join(from, f)).isFile())
    .sort()
  const hash = createHash('sha256')
  for (const f of files)
    hash.update(`${f.replaceAll(sep, '/')}\0`).update(readFileSync(join(from, f)))
  const to = join(cacheDir(), `${basename(from)}-${hash.digest('hex').slice(0, 16)}`)
  if (!existsSync(to)) {
    const partial = `${to}.${process.pid}.partial`
    for (const f of files) {
      mkdirSync(dirname(join(partial, f)), { recursive: true })
      writeFileSync(join(partial, f), readFileSync(join(from, f)))
    }
    try {
      renameSync(partial, to)
    } catch (error) {
      rmSync(partial, { recursive: true, force: true })
      if (!existsSync(to)) throw error
    }
  }
  extracted.set(from, to)
  return to
}

/** Where a compiled reeval keeps what it copies out of itself. */
function cacheDir(): string {
  const base =
    process.env.XDG_CACHE_HOME ||
    (process.platform === 'win32'
      ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Caches')
        : join(homedir(), '.cache'))
  return join(base, 'reeval')
}

/** `require` as seen from reeval's package: its dependencies and Node's built-ins. */
export const ownRequire = createRequire(ownFile('package.json'))

let versions: Record<string, string> | undefined

/**
 * The version of one of reeval's dependencies, as installed; compiled, as bundled, from the
 * `versions.json` embedded beside its files. Throws for a package it doesn't have.
 */
export function ownVersion(name: string): string {
  if (!COMPILED) return ownRequire(`${name}/package.json`).version
  versions ??= JSON.parse(readFileSync(ownFile('versions.json'), 'utf8')) as Record<string, string>
  const version = versions[name]
  if (!version) throw new Error(`Cannot find module '${name}/package.json'`)
  return version
}

const manifest = JSON.parse(readFileSync(ownFile('package.json'), 'utf8'))

/** This reeval's package name and version, from its package.json. */
export const PACKAGE_NAME: string = manifest.name
export const PACKAGE_VERSION: string = manifest.version

/** The names a project imports reeval by: the package's, and the monorepo's alias for it. */
export const PACKAGE_NAMES: readonly string[] = [...new Set([PACKAGE_NAME, 'reeval'])]

/**
 * This build of reeval: its version and its code's mtime. npm gives every installed file the same
 * mtime, so the version tells releases apart; a rebuild moves the mtime.
 */
export const BUILD_ID = `${PACKAGE_VERSION}:${statSync(COMPILED ? process.execPath : fileURLToPath(HERE)).mtimeMs}`

/**
 * The command that runs the `reeval` at `cli` (a package's `dist/cli.js`) with `args`: Node with
 * `nodeArgs` and the file, or, compiled, this executable, which runs its own code.
 */
export function esCommand(
  cli: string,
  args: readonly string[],
  nodeArgs: readonly string[] = [],
): [string, ...string[]] {
  return COMPILED ? [process.execPath, ...args] : [process.execPath, ...nodeArgs, cli, ...args]
}
