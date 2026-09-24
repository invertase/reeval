import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Loads .env.local, then .env. Neither overrides a variable that's already set, so the
 * environment wins over .env.local, which wins over .env.
 */
export function loadEnvFiles(dir: string): void {
  for (const name of ['.env.local', '.env']) {
    const path = join(dir, name)
    if (existsSync(path)) process.loadEnvFile(path)
  }
}

/** `CI` is set to anything but `false`: records by default, forbids `.only`, names CI authors. */
export const inCI = (env: NodeJS.ProcessEnv = process.env): boolean =>
  !!env.CI && env.CI !== 'false'
