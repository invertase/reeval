#!/usr/bin/env node
// The version-drift leg's check of OpenCode's providers: runs the provider probe
// (packages/harness-opencode/scripts/probe-providers.ts) against the newest @opencode/cli, and
// fails, with a diff, when the table it generates differs from the committed one: a provider
// added, removed or newly refused, or a variable, header, host or endpoint changed. Key-free: the
// probe's proxy answers every request itself.
//
//   node --experimental-strip-types scripts/drift/opencode-providers.mjs
//
// REEVAL_DRIFT_OPENCODE_VERSION names a version instead of the newest; REEVAL_DRIFT_PROBE (with
// REEVAL_DRIFT_CATALOG) diffs an earlier probe's result instead of probing. Appends the diff to
// $GITHUB_STEP_SUMMARY when it's set.
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '../..')
const pkg = join(root, 'packages/harness-opencode')
const { buildTable } = await import(join(pkg, 'scripts/provider-table.ts'))
const { OPENCODE_PROVIDERS, REFUSED_OPENCODE_PROVIDERS } = await import(
  join(pkg, 'src/opencode-providers.ts')
)
const { PROBED_VERSION } = await import(join(pkg, 'src/opencode-provider-table.ts'))

/** The newest @opencode/cli (or REEVAL_DRIFT_OPENCODE_VERSION's), probed: its version and the result. */
async function probeLatest() {
  const dir = mkdtempSync(join(tmpdir(), 'reeval-opencode-drift-'))
  const wanted = process.env.REEVAL_DRIFT_OPENCODE_VERSION || 'latest'
  execFileSync(
    'npm',
    [
      'install',
      '--prefix',
      dir,
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      `@opencode/cli@${wanted}`,
    ],
    { stdio: 'inherit' },
  )
  const version = JSON.parse(
    readFileSync(join(dir, 'node_modules/@opencode/cli/package.json'), 'utf8'),
  ).version
  const catalog = join(dir, 'catalog.json')
  const response = await fetch('https://models.opencode.ai/api.json')
  if (!response.ok) throw new Error(`models.opencode.ai: HTTP ${response.status}`)
  writeFileSync(catalog, await response.text())
  console.log(`probing @opencode/cli ${version} (the table is from ${PROBED_VERSION})`)
  const probeFile = join(dir, 'probe.json')
  const probe = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      join(pkg, 'scripts/probe-providers.ts'),
      join(dir, 'node_modules/.bin/opencode'),
      catalog,
      probeFile,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  )
  if (probe.status !== 0) throw new Error(`the probe exited ${probe.status}`)
  return { version, probeFile, catalog }
}

// REEVAL_DRIFT_PROBE and REEVAL_DRIFT_CATALOG reuse a probe's result (say, to check a fix) instead.
const { version, probeFile, catalog } = process.env.REEVAL_DRIFT_PROBE
  ? {
      version: `probe ${process.env.REEVAL_DRIFT_PROBE}`,
      probeFile: process.env.REEVAL_DRIFT_PROBE,
      catalog: process.env.REEVAL_DRIFT_CATALOG ?? '',
    }
  : await probeLatest()
const latest = buildTable(
  JSON.parse(readFileSync(probeFile, 'utf8')),
  JSON.parse(readFileSync(catalog, 'utf8')),
)

const code = (s) => `\`${s}\``
const header = (h) => (h.scheme === 'bearer' ? 'Authorization: Bearer' : h.name)
const endpoint = (e) =>
  `${e.method.join(',')} ${e.host}${'exact' in e.path ? e.path.exact : ` ~ ${e.path.regex}`}`
const hostsOf = (p) => [...new Set(p.endpoints.map((e) => e.host))]
const describe = (p) => `${p.env}, ${p.headers.map(header).join(' + ')}, ${hostsOf(p).join(', ')}`

/** What changed in one list, as `+`, `-` and `~` lines. */
function changes(label, before, after) {
  const out = []
  for (const x of after) if (!before.includes(x)) out.push(`  + ${label} ${code(x)}`)
  for (const x of before) if (!after.includes(x)) out.push(`  - ${label} ${code(x)}`)
  return out
}

const lines = []
const byId = (list) => new Map(list.map((p) => [p.id, p]))
const [was, now] = [byId(OPENCODE_PROVIDERS), byId(latest.supported)]
const [wasRefused, nowRefused] = [byId(REFUSED_OPENCODE_PROVIDERS), byId(latest.refused)]
for (const [id, p] of now) {
  if (was.has(id)) continue
  lines.push(
    wasRefused.has(id)
      ? `+ ${id}: now supported (${describe(p)}); was refused: ${wasRefused.get(id).why}`
      : `+ ${id}: new provider (${describe(p)})`,
  )
}
for (const [id, p] of was) {
  if (now.has(id)) continue
  lines.push(
    nowRefused.has(id)
      ? `- ${id}: now refused: ${nowRefused.get(id).why} (was ${describe(p)})`
      : `- ${id}: gone from OpenCode (was ${describe(p)})`,
  )
}
for (const [id, p] of now) {
  const old = was.get(id)
  if (!old) continue
  const diff = [
    ...(old.env === p.env ? [] : [`  ~ key ${code(old.env)} → ${code(p.env)}`]),
    ...changes(
      'variable',
      (old.vars ?? []).map((v) => `${v.name}=${v.default} ~ ${v.pattern}`),
      (p.vars ?? []).map((v) => `${v.name}=${v.default} ~ ${v.pattern}`),
    ),
    ...changes('header', old.headers.map(header), p.headers.map(header)),
    ...changes('host', hostsOf(old), hostsOf(p)),
    ...changes('endpoint', old.endpoints.map(endpoint), p.endpoints.map(endpoint)),
  ]
  if (diff.length) lines.push(`~ ${id}:`, ...diff)
}
for (const [id, p] of nowRefused) {
  const old = wasRefused.get(id)
  if (!old && !was.has(id)) lines.push(`+ ${id}: new provider, refused: ${p.why}`)
  else if (old && old.why !== p.why)
    lines.push(`~ ${id}: refused because ${p.why} (was: ${old.why})`)
}
for (const id of wasRefused.keys()) {
  if (!nowRefused.has(id) && !now.has(id)) lines.push(`- ${id}: gone from OpenCode (was refused)`)
}

const title = `OpenCode providers: @opencode/cli ${version} against the table from ${PROBED_VERSION}`
const changed = lines.filter((l) => !l.startsWith(' ')).length
const summary = lines.length
  ? [
      `${title}: ${changed} provider${changed === 1 ? '' : 's'} changed`,
      '',
      ...lines,
      '',
      'Check each change, then bump @opencode/cli and regenerate the table (packages/harness-opencode/README.md, "Providers").',
    ]
  : [`${title}: no change (${latest.supported.length} supported, ${latest.refused.length} refused)`]
console.log(summary.join('\n'))
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### ${title}\n\n${lines.length ? `\`\`\`diff\n${lines.join('\n')}\n\`\`\`\n` : 'No change.\n'}\n`,
  )
}
process.exit(lines.length ? 1 : 0)
