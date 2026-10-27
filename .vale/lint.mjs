#!/usr/bin/env node
// Lints docs/ with the Reeval house style and splits the alerts in two: the
// handwritten prose, which fails the run on any alert (suggestion, warning or
// error), and the blocks that scripts/docs.mjs generates from the code, which
// only a code change can fix and so are listed without failing it. Vale lints
// the whole page and the generated blocks are told apart by line afterwards:
// ignoring them with BlockIgnores makes Vale 3.25.1 skip the prose that follows
// a block holding a code fence, so a handwritten alert went unreported.
//
//   node .vale/lint.mjs [paths…]   (default: docs)
//   node .vale/lint.mjs --self-test
//
// Setup: Vale PINNED_VALE exactly (below) and mdx2vast on PATH.
//
//   Linux/macOS: download vale_<version>_<OS>_<arch> from
//   https://github.com/errata-ai/vale/releases/tag/v3.25.1 and put `vale` on PATH
//   (or `brew install vale` and `brew pin` it at that version)
//   npm install -g mdx2vast
//
// The version is pinned because Vale's results change with it: before 3.18.0 it
// ignored BlockIgnores and TokenIgnores in a section named by a path
// (`[docs/index.mdx]`) and honoured them only under a file-name glob, so the
// exemption for the Introduction lead failed there and 3.25.1 passed it. The
// run stops with exit 2 on any other version, or when vale is missing.
//
// Vale matches the per-file sections of .vale.ini and .vale/lead.ini against
// the path it is given, so each target is resolved against the directory the
// command ran in, made relative to the repo root, and Vale always runs from the
// root. The result then does not depend on how the command was called;
// --self-test checks that it doesn't, that the version pin refuses a mismatch
// and that the lead's exemption holds and stops at the lead.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(script), '..')
const leadFile = 'docs/index.mdx'
const PINNED_VALE = '3.25.1'

function valeVersionProblem(env = process.env) {
  const probe = spawnSync('vale', ['--version'], { encoding: 'utf8', env })
  if (probe.error) {
    return `vale is not on PATH. Install Vale ${PINNED_VALE} (https://github.com/errata-ai/vale/releases/tag/v${PINNED_VALE}) and run again.`
  }
  const found = /(\d+\.\d+\.\d+)/.exec(probe.stdout ?? '')?.[1]
  if (found === PINNED_VALE) return undefined
  return `vale ${found ?? `(unreadable: ${JSON.stringify((probe.stdout ?? '').trim())})`} is installed, but the docs lint needs exactly ${PINNED_VALE}: other versions read .vale.ini and .vale/lead.ini differently and report different alerts. Install Vale ${PINNED_VALE} from https://github.com/errata-ai/vale/releases/tag/v${PINNED_VALE} and run again.`
}

function requireVale() {
  const problem = valeVersionProblem()
  if (!problem) return
  console.error(`docs lint: ${problem}`)
  process.exit(2)
}

function runLint(args, env) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: 'utf8', env })
}

function pinCases() {
  if (process.platform === 'win32') return
  const dir = mkdtempSync(path.join(os.tmpdir(), 'reeval-vale-'))
  const shim = (name, body) => {
    const bin = path.join(dir, name)
    mkdirSync(bin, { recursive: true })
    writeFileSync(path.join(bin, 'vale'), `#!/bin/sh\n${body}\n`)
    chmodSync(path.join(bin, 'vale'), 0o755)
    return { ...process.env, PATH: bin }
  }
  const [major, minor] = PINNED_VALE.split('.')
  const cases = [
    ['an older vale', shim('old', 'echo "vale version 3.12.0"'), /3\.12\.0 is installed/],
    [
      'a newer vale',
      shim('new', `echo "vale version ${major}.${Number(minor) + 1}.0"`),
      /is installed, but the docs lint needs exactly/,
    ],
    ['an unreadable version', shim('odd', 'echo "dev"'), /unreadable/],
    ['no vale', { ...process.env, PATH: path.join(dir, 'empty') }, /not on PATH/],
  ]
  let failed = false
  for (const [name, env, message] of cases) {
    const run = runLint([], env)
    const ok = run.status === 2 && message.test(run.stderr) && run.stderr.includes(PINNED_VALE)
    console.log(`${ok ? '  ok' : 'FAIL'}  version pin refuses ${name}`)
    if (!ok) failed = true
  }
  rmSync(dir, { recursive: true, force: true })
  if (failed) {
    console.error('Self-test failed: the version pin did not stop a mismatched or missing vale.')
    process.exit(1)
  }
}

function leadCases() {
  const lintLead = (file) => {
    let out
    try {
      out = execFileSync('vale', ['--output=JSON', '--config=.vale/lead.ini', file], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
    } catch (error) {
      if (error.status !== 1 || !error.stdout) throw error
      out = error.stdout
    }
    return Object.values(JSON.parse(out || '{}')).flat()
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'reeval-vale-'))
  const canary = path.join(dir, 'index.mdx')
  writeFileSync(
    canary,
    [
      '---',
      'title: "Introduction"',
      '---',
      '',
      '## Introduction',
      '',
      'First paragraph, with your change.',
      '',
      'Second paragraph, with your change.',
      '',
      'Third paragraph, with your change.',
      '',
      'Fourth paragraph, with your change.',
      '',
    ].join('\n'),
  )
  const flagged = lintLead(canary).filter((a) => a.Check === 'Reeval.Your')
  rmSync(dir, { recursive: true, force: true })
  const real = lintLead(leadFile).filter((a) => a.Check === 'Reeval.Your')
  const canaryOk = flagged.length === 1 && flagged[0].Line === 13
  const realOk = real.length === 0
  console.log(
    `${canaryOk ? '  ok' : 'FAIL'}  lead exemption covers three paragraphs and stops at the fourth`,
  )
  console.log(`${realOk ? '  ok' : 'FAIL'}  ${leadFile} has no "your" alert outside its lead`)
  if (!(canaryOk && realOk)) {
    console.error('Self-test failed: the lead exemption in .vale/lead.ini does not hold.')
    process.exit(1)
  }
}

function generatedCases() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'reeval-vale-'))
  const canary = path.join(dir, 'page.mdx')
  const block = ['[//]: # (generated:a)', '', '```text', 'x', '```', '', '[//]: # (/generated:a)']
  writeFileSync(canary, ['A page.', '', ...block, '', 'It was cancelled.', ''].join('\n'))
  let out
  try {
    out = execFileSync('vale', ['--output=JSON', canary], { cwd: repoRoot, encoding: 'utf8' })
  } catch (error) {
    if (error.status !== 1 || !error.stdout) throw error
    out = error.stdout
  }
  rmSync(dir, { recursive: true, force: true })
  const alerts = Object.values(JSON.parse(out || '{}')).flat()
  const ok = alerts.length === 1 && alerts[0].Check === 'Reeval.USSpelling' && alerts[0].Line === 11
  console.log(`${ok ? '  ok' : 'FAIL'}  prose after a generated block with a code fence is linted`)
  if (!ok) {
    console.error('Self-test failed: Vale skipped prose that follows a generated block.')
    process.exit(1)
  }
}

function selfTest() {
  requireVale()
  pinCases()
  leadCases()
  generatedCases()
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

requireVale()

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
const inGenerated = new Map()
const isGenerated = (alert) => {
  if (!inGenerated.has(alert.file)) inGenerated.set(alert.file, generatedLines(alert.file))
  return inGenerated.get(alert.file).has(alert.Line)
}
const alerts = flatten(vale([]))
const handwritten = [
  ...alerts.filter((alert) => !isGenerated(alert)),
  ...(lintsLead ? flatten(vale(['--config=.vale/lead.ini'], [leadFile])) : []),
]
const generated = alerts.filter(isGenerated)

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
