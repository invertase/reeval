// Copies pnpm-lock.yaml and patches/ from each task's starting commit into sandbox/lockfiles/, the
// Docker build context, before `pnpm reeval image build`.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = (path) => fileURLToPath(new URL(path, import.meta.url))
const tasks = readFileSync(here('../tasks.ts'), 'utf8')
const parents = [...tasks.matchAll(/parent: '([0-9a-f]{40})'/g)].map((m) => m[1])
const out = here('../sandbox/lockfiles/')

rmSync(out, { recursive: true, force: true })
for (const sha of parents) {
  const dir = `${out}${sha.slice(0, 12)}`
  mkdirSync(dir, { recursive: true })
  const tar = execFileSync(
    'git',
    ['-C', here('../../..'), 'archive', sha, 'pnpm-lock.yaml', 'patches'],
    {
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  execFileSync('tar', ['-x', '-C', dir], { input: tar })
}
console.log(`${parents.length} lockfiles in ${out}`)
