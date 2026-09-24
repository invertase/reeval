import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Loads .env then .env.local without overriding variables already set. */
export function loadEnvFiles(dir: string): void {
  for (const name of ['.env.local', '.env']) {
    const path = join(dir, name)
    if (existsSync(path)) process.loadEnvFile(path)
  }
}
