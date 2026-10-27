#!/usr/bin/env node
// Lints docs/ with the Reeval house style and splits the alerts in two: the
// handwritten prose, which fails the run on any alert (suggestion, warning or
// error), and the blocks that scripts/docs.mjs generates from the code, which
// only a code change can fix and so are listed without failing it.
//
//   node .vale/lint.mjs [paths…]   (default: docs)
//
// Needs vale and mdx2vast on PATH.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const paths = process.argv.slice(2)
const targets = paths.length ? paths : ['docs']

function vale(args, only = targets) {
  let out
  try {
    out = execFileSync('vale', ['--output=JSON', ...args, ...only], {
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
  readFileSync(file, 'utf8')
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
  ...(targets.some((t) => 'docs/index.mdx'.startsWith(t.replace(/\/$/, '')))
    ? flatten(vale(['--config=.vale/lead.ini'], ['docs/index.mdx']))
    : []),
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
