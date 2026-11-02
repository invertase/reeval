// The nightly drift workflow's version check, key-free: the newest release of each agent CLI and
// SDK the sandbox images pin, and of the AI SDK harness adapters reeval pins, against the pins in
// the source. Fails (exit 1) naming each one that moved, with the file its pin lives in; a lookup
// that fails exits 2.
//   node scripts/drift/versions.mjs [--previous <snapshot.json>] [--out <snapshot.json>]
// --out writes what it found ({ [name]: { kind, pinned, latest } }); --previous names an earlier
// one, to tell which latest versions changed since. With $GITHUB_OUTPUT set it writes `moved`
// (every name whose newest isn't its pin), `changed` (every name whose newest changed since
// --previous, or all of them without one; an unreadable one counts as none), `new_agents` (the
// agent CLIs in both, which latest-images.sh would swap in), and `new_rows` and `moved_rows` (the
// contract rows of the agent CLIs in `new_agents` and in `moved`), each comma-separated; with
// $GITHUB_STEP_SUMMARY, a table.
// GITHUB_TOKEN, when set, authenticates the GitHub release lookups.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '../..')
const { values: args } = parseArgs({
  options: { previous: { type: 'string' }, out: { type: 'string' } },
})

/** An agent CLI or SDK: its contract rows, the constant that pins it and where its releases are. */
const AGENTS = [
  {
    name: 'agy',
    rows: ['antigravity'],
    file: 'packages/harness-antigravity/src/antigravity-bootstrap.ts',
    pin: 'ANTIGRAVITY_CLI_VERSION',
    github: 'google-antigravity/antigravity-cli',
  },
  {
    name: '@cursor/sdk',
    rows: ['cursor'],
    file: 'packages/harness-cursor-sdk/src/cursor-sdk-bootstrap.ts',
    pin: 'CURSOR_SDK_VERSION',
    npm: '@cursor/sdk',
  },
  {
    name: '@opencode/cli',
    rows: ['opencode', 'opencode-anthropic', 'opencode-openai'],
    file: 'packages/harness-opencode/src/opencode-harness.ts',
    pin: 'OPENCODE_CLI_VERSION',
    npm: '@opencode/cli',
  },
  {
    name: 'goose',
    rows: ['goose'],
    file: 'packages/harness-goose/src/goose-harness.ts',
    pin: 'GOOSE_CLI_VERSION',
    github: 'aaif-goose/goose',
  },
  {
    name: 'pi',
    rows: ['pi'],
    file: 'packages/harness-pi/src/pi-bootstrap.ts',
    pin: 'PI_CLI_VERSION',
    npm: '@earendil-works/pi-coding-agent',
  },
  {
    name: 'codex',
    rows: ['codex'],
    file: 'packages/harness-codex/src/codex-bootstrap.ts',
    pin: 'CODEX_CLI_VERSION',
    npm: '@openai/codex',
  },
  {
    name: 'fx',
    rows: ['fx'],
    file: 'packages/harness-fx/src/fx-harness.ts',
    pin: 'FX_CLI_VERSION',
    github: 'vercel-labs/fx',
  },
  {
    name: 'grok',
    rows: ['grok-build'],
    file: 'packages/harness-grok-build/src/grok-build-harness.ts',
    pin: 'GROK_CLI_VERSION',
    npm: '@xai-official/grok',
  },
]
/** The AI SDK harness adapters, pinned exactly in reeval's package.json. */
const ADAPTERS = ['@ai-sdk/harness', '@ai-sdk/harness-acp', '@ai-sdk/harness-claude-code']

const strip = (v) => v.replace(/^v/, '')

async function get(url, headers = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json', ...headers } })
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
      return await response.json()
    } catch (error) {
      if (attempt === 3) throw error
      await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
}
const npmLatest = async (name) => (await get(`https://registry.npmjs.org/${name}/latest`)).version
const githubLatest = async (repo) => {
  const auth = process.env.GITHUB_TOKEN
    ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {}
  return strip((await get(`https://api.github.com/repos/${repo}/releases/latest`, auth)).tag_name)
}

function agentPin({ name, file, pin }) {
  const source = readFileSync(join(root, file), 'utf8')
  const m = source.match(new RegExp(`export const ${pin} = '([^']+)'`))
  if (!m) throw new Error(`${name}: no ${pin} in ${file}`)
  return m[1]
}
const reevalPackage = 'packages/reeval/package.json'
const { dependencies = {}, devDependencies = {} } = JSON.parse(
  readFileSync(join(root, reevalPackage), 'utf8'),
)

const rows = []
try {
  for (const agent of AGENTS) {
    const latest = agent.npm ? await npmLatest(agent.npm) : await githubLatest(agent.github)
    rows.push({
      name: agent.name,
      kind: 'agent',
      rows: agent.rows,
      file: agent.file,
      pinned: strip(agentPin(agent)),
      latest,
    })
  }
  for (const name of ADAPTERS) {
    const pinned = dependencies[name] ?? devDependencies[name]
    if (!pinned) throw new Error(`${name}: not in ${reevalPackage}`)
    rows.push({ name, kind: 'adapter', file: reevalPackage, pinned, latest: await npmLatest(name) })
  }
} catch (error) {
  console.log(`::error::Couldn't look up the newest versions: ${error.message}`)
  process.exit(2)
}

/** The --previous snapshot, or null when there's none or it doesn't parse to one. */
function readPrevious() {
  if (!args.previous || !existsSync(args.previous)) return null
  try {
    const snapshot = JSON.parse(readFileSync(args.previous, 'utf8'))
    if (snapshot && typeof snapshot === 'object') return snapshot
  } catch {}
  console.log(
    `::warning::${args.previous} isn't a versions snapshot: every newest version counts as new`,
  )
  return null
}
const previous = readPrevious()
const moved = rows.filter((r) => r.latest !== r.pinned)
const changed = rows.filter((r) => !previous || previous[r.name]?.latest !== r.latest)
const newAgents = moved.filter((r) => r.kind === 'agent' && changed.includes(r))

if (args.out)
  writeFileSync(
    args.out,
    `${JSON.stringify(Object.fromEntries(rows.map(({ name, kind, pinned, latest }) => [name, { kind, pinned, latest }])), null, 2)}\n`,
  )
const names = (list) => list.map((r) => r.name).join(',')
const contractRows = (list) => list.flatMap((r) => r.rows ?? []).join(',')
if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `moved=${names(moved)}`,
      `changed=${names(changed)}`,
      `new_agents=${names(newAgents)}`,
      `new_rows=${contractRows(newAgents)}`,
      `moved_rows=${contractRows(moved.filter((r) => r.kind === 'agent'))}`,
      '',
    ].join('\n'),
  )

const fresh = (r) => r.latest !== r.pinned && changed.includes(r) && previous
const status = (r) =>
  r.latest === r.pinned ? 'current' : fresh(r) ? '**behind, new since last night**' : 'behind'
const newSince = moved.filter(fresh)
const table = [
  '### Newest versions against the pins',
  '',
  `${moved.length} of ${rows.length} behind their pins${previous ? `; new since last night: ${names(newSince).replaceAll(',', ', ') || 'none'}` : ''}.`,
  '',
  '| | pinned | newest | |',
  '|---|---|---|---|',
  ...[
    ...newSince,
    ...moved.filter((r) => !newSince.includes(r)),
    ...rows.filter((r) => !moved.includes(r)),
  ].map((r) => `| ${r.name} | ${r.pinned} | ${r.latest} | ${status(r)} |`),
].join('\n')
console.log(table)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n\n`)

for (const r of moved) {
  const fix =
    r.kind === 'agent'
      ? `bump its pin in ${r.file}, then run the real-agent contract on it`
      : `bump the AI SDK family by hand in every package that pins it (AGENTS.md, "Dependabot")`
  console.log(`::error::${r.name} ${r.latest} is out, pinned ${r.pinned}: ${fix}`)
}
process.exit(moved.length ? 1 : 0)
