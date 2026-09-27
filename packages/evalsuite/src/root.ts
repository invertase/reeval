import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// This file is directly in src/, and the build puts every chunk directly in dist/, so the
// package is one level up either way. Other modules find ES's own files from here.
export const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url))
export const DIST_DIR = join(PACKAGE_DIR, 'dist')

/** This ES's version, from its package.json. */
export const PACKAGE_VERSION: string = JSON.parse(
  readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'),
).version
