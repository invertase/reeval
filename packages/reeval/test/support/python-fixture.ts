// Point a copied fixture's uv project at the monorepo reeval-python package (absolute path).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { testDir } from './fixture.ts'

const sdkRoot = (): string => resolve(join(testDir, '..', '..', 'reeval-python'))

export function syncPythonFixtureProject(dir: string): void {
  const pyproject = join(dir, 'pyproject.toml')
  if (!existsSync(pyproject)) return
  const sdk = sdkRoot()
  const toml = readFileSync(pyproject, 'utf8').replace(
    /path = "[^"]*reeval-python"/,
    `path = "${sdk}"`,
  )
  writeFileSync(pyproject, toml)
  execFileSync('uv', ['sync'], { cwd: dir, stdio: 'pipe' })
}
