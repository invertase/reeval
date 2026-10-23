// Fixtures with `*.eval.dart` files have no pub packages of their own: reeval runs them with the
// monorepo's reeval-dart, whose packages this resolves once.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { testDir } from './fixture.ts'

export const dartSdk = resolve(join(testDir, '..', '..', 'reeval-dart'))

export function prepareDartSdk(): void {
  if (existsSync(join(dartSdk, '.dart_tool', 'package_config.json'))) return
  execFileSync('dart', ['pub', 'get'], { cwd: dartSdk, stdio: 'pipe' })
}
