// Inventory the daily dependency watch reads. Core AI SDK packages are first-class:
// check experimental_evaluate / experimental_decide, decisionModel vs evaluationModel,
// and multimodal state / file parts — not only harness CLI pins.
//
// Usage: node scripts/dependency-watch.mjs
// Uses `npm view` for latest version, publish time and the package's changelog URL.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'packages/reeval/package.json'), 'utf8'))

/** Packages whose evaluate/decide surface the judge calls. */
const CORE = [
  {
    name: 'ai',
    changelog: 'https://github.com/vercel/ai/blob/main/packages/ai/CHANGELOG.md',
    flags: [
      'experimental_evaluate / experimental_decide (rename, aliases)',
      'decisionModel vs evaluationModel',
      'multimodal state / file parts ({ type: "file", mediaType, data })',
    ],
  },
  {
    name: '@ai-sdk/typesafe-ai',
    changelog: 'https://github.com/vercel/ai/blob/main/packages/typesafe-ai/CHANGELOG.md',
    flags: [
      'decisionModel vs evaluationModel',
      'file parts in decide state (TypeSafe accepts text and JSON only)',
    ],
  },
  {
    name: '@ai-sdk/google',
    changelog: 'https://github.com/vercel/ai/blob/main/packages/google/CHANGELOG.md',
    flags: ['decisionModel vs evaluationModel', 'language-model adapter image / file parts'],
  },
]

function npmView(name, fields) {
  const raw = execFileSync('npm', ['view', name, ...fields, '--json'], {
    encoding: 'utf8',
  }).trim()
  return raw ? JSON.parse(raw) : null
}

function pinnedOf(name) {
  return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? null
}

const rows = []
for (const item of CORE) {
  const pinned = pinnedOf(item.name)
  const latest = npmView(item.name, ['version', 'time'])
  const version = typeof latest === 'string' ? latest : latest?.version
  const time =
    latest && typeof latest === 'object' && latest.time && typeof latest.time === 'object'
      ? latest.time[version]
      : null
  rows.push({
    name: item.name,
    pinned,
    latest: version,
    published: time ?? '',
    changelog: item.changelog,
    flags: item.flags,
  })
}

console.log('## Core AI SDK')
console.log('')
console.log(
  'First-class watch targets for the judge (`experimental_evaluate` / `experimental_decide`).',
)
console.log('A bump here can unlock or break `c.judge({ artifacts })` even when')
console.log('harness CLI pins are unchanged.')
console.log('')
console.log('| package | pinned | latest | published |')
console.log('|---|---|---|---|')
for (const r of rows) {
  console.log(`| ${r.name} | ${r.pinned ?? '—'} | ${r.latest} | ${r.published} |`)
}
console.log('')
for (const r of rows) {
  console.log(`### ${r.name}`)
  console.log(`changelog: ${r.changelog}`)
  console.log('flag:')
  for (const f of r.flags) console.log(`- ${f}`)
  console.log('')
}
