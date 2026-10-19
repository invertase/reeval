// Writes vendor/, which the evals seed into each attempt and which git ignores:
//   reeval.tgz            this checkout's reeval, packed (run `pnpm build` first)
//   docs/                 the docs site's pages, with {{ pkg }} rendered as reeval
//   skill-current/reeval  the skill as it was before the split, from CURRENT_SKILL_REF
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const CURRENT_SKILL_REF = 'f89798f5c1ebd96f65405087bb4630fb95fd5379'

const here = dirname(fileURLToPath(import.meta.url))
const suite = join(here, '..')
const repo = join(here, '..', '..', '..', '..')
const vendor = join(suite, 'vendor')
rmSync(vendor, { recursive: true, force: true })
mkdirSync(vendor, { recursive: true })

const packed = execFileSync('pnpm', ['pack', '--pack-destination', vendor], {
  cwd: join(repo, 'packages', 'reeval'),
  encoding: 'utf8',
})
const tarball = packed.trim().split('\n').at(-1)
cpSync(tarball, join(vendor, 'reeval.tgz'))
rmSync(tarball)

const pkg = JSON.parse(readFileSync(join(repo, 'docs.json'), 'utf8')).variables?.pkg ?? 'reeval'
const docs = join(repo, 'docs')
for (const entry of readdirSync(docs, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.mdx')) continue
  const from = join(entry.parentPath, entry.name)
  const to = join(vendor, 'docs', relative(docs, from))
  mkdirSync(dirname(to), { recursive: true })
  writeFileSync(to, readFileSync(from, 'utf8').replaceAll('{{ pkg }}', pkg))
}

const skill = join(vendor, 'skill-current', 'reeval')
mkdirSync(skill, { recursive: true })
const current = execFileSync(
  'git',
  ['show', `${CURRENT_SKILL_REF}:.agents/skills/reeval/SKILL.md`],
  { cwd: repo, encoding: 'utf8' },
)
writeFileSync(join(skill, 'SKILL.md'), current)

console.log(`vendor/ ready: reeval.tgz, docs/, skill-current/ (${CURRENT_SKILL_REF.slice(0, 8)})`)
