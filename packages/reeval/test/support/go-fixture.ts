// Point a copied fixture's go.mod at the monorepo's Go SDK (absolute path).
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { testDir } from './fixture.ts'

export function useRepoGoSdk(dir: string): void {
  const sdk = resolve(join(testDir, '..', '..', '..', 'sdks', 'go')).replace(/\\/g, '/')
  const gomod = join(dir, 'go.mod')
  writeFileSync(gomod, readFileSync(gomod, 'utf8').replace(/=> \S*sdks\/go$/m, `=> ${sdk}`))
}
