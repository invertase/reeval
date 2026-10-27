#!/usr/bin/env node
// Lints docs/ with the Reeval house style and splits the alerts in two: the
// handwritten prose, which fails the run on any alert (suggestion, warning or
// error), and the blocks that scripts/docs.mjs generates from the code, which
// only a code change can fix and so are listed without failing it.
//
//   node .vale/lint.mjs [paths…]   (default: docs)
//   node .vale/lint.mjs --self-test
//
// Needs vale and mdx2vast on PATH. Vale matches the per-file sections of
// .vale.ini and .vale/lead.ini against the path it is given, so each target
// is resolved against the directory the command ran in, made relative to the
// repo root, and Vale always runs from the root. The result then does not
// depend on how the command was called; --self-test checks that it doesn't.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(script), '..')
const leadFile = 'docs/index.mdx'

function selfTest() {
  const docs = path.join(repoRoot, 'docs')
  const cases = [
    { name: 'no target', args: [], cwd: repoRoot },
    { name: 'docs', args: ['docs'], cwd: repoRoot },
    { name: 'docs/', args: ['docs/'], cwd: repoRoot },
    { name: './docs', args: ['./docs'], cwd: repoRoot },
    { name: 'absolute docs', args: [docs], cwd: repoRoot },
    { name: 'no target, from docs/', args: [], cwd: docs },
    { name: '. from docs/', args: ['.'], cwd: docs },
    {
      name: '../../docs from docs/reference',
      args: ['../../docs'],
      cwd: path.join(docs, 'reference'),
    },
  ]
  const count = (args, cwd) => {
    let out
    try {
      out = execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })
    } catch (error) {
      if (!error.stdout) throw error
      out = error.stdout
    }
    return Number(/Handwritten prose: (\d+)/.exec(out)?.[1])
  }
  const results = cases.map((c) => ({ ...c, count: count(c.args, c.cwd) }))
  for (const r of results) console.log(`${String(r.count).padStart(4)}  ${r.name}`)
  const lead = [
    count([leadFile], repoRoot),
    count([path.join(repoRoot, leadFile)], repoRoot),
    count(['index.mdx'], docs),
  ]
  console.log(`${lead.join(', ')}  ${leadFile} by relative, absolute and from docs/`)
  const counts = new Set([...results.map((r) => r.count), ...lead])
  if (counts.size !== 1) {
    console.error('Self-test failed: the handwritten count depends on how Vale is called.')
    process.exit(1)
  }
  console.log('Self-test passed: every invocation reports the same count.')
}

if (process.argv[2] === '--self-test') {
  selfTest()
  process.exit(0)
}

const toRoot = (t) => path.relative(repoRoot, path.resolve(t)).split(path.sep).join('/') || '.'
const targets = (
  process.argv.length > 2 ? process.argv.slice(2) : [path.join(repoRoot, 'docs')]
).map(toRoot)
const lintsLead = targets.some(
  (t) => t === '.' || leadFile === t || leadFile.startsWith(`${t.replace(/\/$/, '')}/`),
)

function vale(args, only = targets) {
  let out
  try {
    out = execFileSync('vale', ['--output=JSON', ...args, ...only], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    if (error.status !== 1 || !error.stdout) throw error
    out = error.stdout
  }
  return JSON.parse(out || '{}')
}

const MARKER = /^\[\/\/\]: # \((\/?)generated:[^)]+\)/

function generatedLines(file) {
  const lines = new Set()
  let inside = false
  readFileSync(path.join(repoRoot, file), 'utf8')
    .split('\n')
    .forEach((line, index) => {
      const marker = MARKER.exec(line)
      if (marker) inside = marker[1] !== '/'
      else if (inside) lines.add(index + 1)
    })
  return lines
}

function flatten(result) {
  return Object.entries(result).flatMap(([file, alerts]) =>
    alerts.map((alert) => ({ file, ...alert })),
  )
}

// .vale.ini turns Reeval.Your off for docs/index.mdx; .vale/lead.ini checks
// it there outside the getting-started lead.
const handwritten = [
  ...flatten(vale([])),
  ...(lintsLead ? flatten(vale(['--config=.vale/lead.ini'], [leadFile])) : []),
]
const generated = flatten(vale(['--config=.vale/generated.ini'])).filter((alert) =>
  generatedLines(alert.file).has(alert.Line),
)

function print(title, alerts) {
  console.log(`\n${title}: ${alerts.length}`)
  const byRule = new Map()
  for (const alert of alerts) {
    byRule.set(alert.Check, (byRule.get(alert.Check) ?? 0) + 1)
  }
  for (const [rule, count] of [...byRule].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${rule}`)
  }
  for (const alert of alerts) {
    const where = `${alert.file}:${alert.Line}:${alert.Span[0]}`
    console.log(`${where}  ${alert.Severity}  ${alert.Check}  ${alert.Message}`)
  }
}

print('Handwritten prose', handwritten)
print('Generated from the code (fix in the code, not the page)', generated)

process.exitCode = handwritten.length ? 1 : 0
