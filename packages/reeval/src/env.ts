import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { withoutBom } from './text.ts'

/**
 * Loads .env.local, then .env, from the config file's directory (the current one only without a
 * config), so `reeval run` from a subdirectory reads the project's. Neither overrides a variable
 * that's already set, so the environment wins over .env.local, which wins over .env.
 */
export function loadEnvFiles(configPath: string | undefined): void {
  const dir = configPath ? dirname(configPath) : resolve('.')
  for (const name of ['.env.local', '.env']) {
    const path = join(dir, name)
    if (!existsSync(path)) continue
    for (const [key, value] of Object.entries(parseEnv(withoutBom(readFileSync(path, 'utf8'))))) {
      process.env[key] ??= value
    }
  }
}

/** `CI` is set to anything but `false`: records by default, forbids `.only`, names CI authors. */
export const inCI = (env: NodeJS.ProcessEnv = process.env): boolean =>
  !!env.CI && env.CI !== 'false'
