// The harness feature matrix in README.md and the docs' Harnesses guide, from the code: the
// harness catalog (src/harness/agents.ts), each adapter's builtin tool catalog, and the rows of
// the harness contract (test/support/harnesses.ts), whose real runs check tokens and the served
// model. Every note is tied to the fact it explains, so it goes when that fact changes.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const src = join(root, 'packages/evalsuite/src')
const agentsModule = await import(join(src, 'harness/agents.ts'))
const { AGENTS, gooseMcpServers } = agentsModule
const { InfraError } = await import(join(src, 'sandbox/types.ts'))
const { harnesses } = await import(join(root, 'packages/evalsuite/test/support/harnesses.ts'))

const TRANSPORTS = ['stdio', 'http', 'sse']
const PROBE = {
  stdio: { transport: 'stdio', command: 'probe', args: [], env: {} },
  http: { transport: 'http', url: 'https://mcp.example/mcp', headers: {} },
  sse: { transport: 'sse', url: 'https://mcp.example/sse', headers: {} },
}

/** Whether the agent takes an MCP server of each transport, and when ES refuses one it can't. */
function mcpSupport(kind, agent, problems) {
  // refusedMcp covers every transport; refusedSse, its predecessor, only mcp.sse.
  const planRefusal = agentsModule.refusedMcp ?? agentsModule.refusedSse
  if (!planRefusal) problems.push('agents.ts exports neither refusedMcp nor refusedSse')
  const out = {}
  for (const transport of TRANSPORTS) {
    let refused = false
    try {
      agent.mcpServers({ probe: PROBE[transport] })
    } catch (error) {
      if (!(error instanceof InfraError)) throw error
      refused = true
    }
    const layers = [{ spec: { mcp: { probe: PROBE[transport] } } }]
    const atPlan = refused && !!planRefusal?.({ kind, model: 'probe' }, layers)
    out[transport] = { ok: !refused, atPlan }
  }
  return out
}

/** The web events ES records for an agent: its adapter's tools that the transcript maps to them. */
async function webEvents(kind, agent) {
  const adapter = await agent.adapter({
    auth: { [agent.credential]: 'probe' },
    descriptor: { kind, model: 'probe' },
  })
  const tools = Object.keys(adapter.builtinTools ?? {})
  return {
    search: tools.includes('webSearch'),
    fetch: tools.includes('webFetch') || tools.includes('WebFetch'),
  }
}

const list = (items) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

const code = (s) => `\`${s}\``

/** Each note is said only while its fact holds. */
const NOTES = [
  (h) =>
    h.agent.tokens &&
    `The gateway also swaps the session tokens the ${h.agent.name} SDK exchanges its key for (${list(h.agent.tokens.fields.map(code))}) on ${list(h.agent.tokens.hosts.map(code))}.`,
  (h) => {
    const off = TRANSPORTS.filter((t) => !h.mcp[t].ok)
    if (!off.length) return false
    const plan = off.filter((t) => h.mcp[t].atPlan)
    const when =
      plan.length === off.length
        ? 'refused at plan time (exit 2)'
        : plan.length
          ? `refused at plan time for ${list(plan.map((t) => code(`mcp.${t}`)))}, when the attempt starts otherwise`
          : 'refused when the attempt starts'
    return off.length === TRANSPORTS.length
      ? `No MCP client: an eval that gives it MCP servers is ${when}.`
      : `No ${list(off.map((t) => code(`mcp.${t}`)))} transport: those servers are ${when}.`
  },
  (h) =>
    h.agent.mcpServers === gooseMcpServers &&
    `MCP servers go in its ${code('config.yaml')} as enabled extensions, not over ACP, where they start disabled.`,
  (h) => !h.row.tokens && `No tokens recorded: ${h.row.tokensWhy}`,
  (h) =>
    !h.row.servedModel &&
    h.row.wireModel &&
    `Served model from the gateway's requests only (the record's ${code('servedModels')}); each turn's ${code('model')} is null.`,
  (h) =>
    h.row.servedModel &&
    !h.row.wireModel &&
    `Served model as the harness reports it: its API requests don't name one, so the record's ${code('servedModels')} is null.`,
  (h) =>
    h.agent.unreported &&
    h.kind === 'cursor' &&
    `Its SDK leaves web search and fetch calls out of the stream; ES recovers them from the stored conversation, and a turn it can't recover is marked ${code('unreported')} so web matchers refuse it.`,
  (h) =>
    h.kind === 'opencode' &&
    !h.web.search &&
    h.web.fetch &&
    `Web fetch only: OpenCode offers ${code('websearch')} only on its own provider or with Exa or Parallel enabled, and ES runs it on ${code('google')} with neither.`,
  (h) =>
    h.agent.expectedBlocked &&
    `Its CLI always tries ${list(h.agent.expectedBlocked.hosts.map(code))}; a restricted egress policy refuses them and records them under the record's ${code('egress.expectedBlocked')}.`,
]

/** The facts for each real harness, in the catalog's order, and whatever doesn't add up. */
export async function harnessFacts() {
  const problems = []
  const facts = []
  const agentTs = readFileSync(join(src, 'harness/agent.ts'), 'utf8')
  if (!agentTs.includes('harness needs the Docker sandbox')) {
    problems.push(
      "harness/agent.ts no longer refuses a non-Docker sandbox: update the matrix's Sandbox column",
    )
  }
  for (const [kind, agent] of Object.entries(AGENTS)) {
    const row = harnesses.find((r) => r.id === kind)
    if (!row) {
      problems.push(`harness ${kind} has no row in test/support/harnesses.ts`)
      continue
    }
    const page = `reference/harness/${kind}`
    if (!existsSync(join(root, 'docs', `${page}.mdx`)))
      problems.push(`harness ${kind} has no docs/${page}.mdx`)
    if (row.key?.name !== agent.credential) {
      problems.push(
        `${kind}: the contract row's key is ${row.key?.name}, the catalog's ${agent.credential}`,
      )
    }
    if (!!row.wireModel !== !!agent.servedModel) {
      problems.push(
        `${kind}: the contract row's wireModel and the catalog's servedModel disagree on whether its requests name the model`,
      )
    }
    if (!row.tokens && !row.tokensWhy)
      problems.push(`${kind}: a contract row with tokens: false needs tokensWhy`)
    const mcp = mcpSupport(kind, agent, problems)
    if ((row.mcp !== false) !== mcp.stdio.ok) {
      problems.push(`${kind}: the contract row's mcp and the catalog disagree on stdio MCP servers`)
    }
    const h = { kind, agent, row, page, mcp, web: await webEvents(kind, agent) }
    h.notes = NOTES.map((note) => note(h)).filter(Boolean)
    facts.push(h)
  }
  for (const row of harnesses) {
    if (row.id !== 'fake' && !AGENTS[row.id])
      problems.push(`contract row ${row.id} isn't in AGENTS`)
  }
  return { facts, problems }
}

const yes = (ok) => (ok ? '✓' : '✗')

/**
 * The matrix and its notes. `href` turns a docs page (`reference/harness/pi`) into a link for
 * the file it goes in; `text` escapes a note for it.
 */
export function renderMatrix(facts, { href, text = (s) => s }) {
  const head = [
    'Harness',
    'Key',
    'Key brokered',
    'Rules file',
    'Skills: workspace',
    'Skills: home',
    'MCP stdio',
    'MCP http',
    'MCP sse',
    'Tokens',
    'Served model',
    'Web search events',
    'Web fetch events',
    'Sandbox',
  ]
  const rows = facts.map((h) => [
    `[${h.agent.name}](${href(h.page)})`,
    code(h.agent.credential),
    yes(h.agent.endpoints.length > 0),
    code(h.agent.rulesFile),
    yes(!!h.agent.workspaceSkillDir),
    yes(!!h.agent.harnessSkillDir),
    ...TRANSPORTS.map((t) => yes(h.mcp[t].ok)),
    yes(h.row.tokens),
    h.row.servedModel ? '✓' : h.row.wireModel ? 'partial' : '✗',
    yes(h.web.search),
    yes(h.web.fetch),
    code('docker()'),
  ])
  const line = (cells) => `| ${cells.join(' | ')} |`
  return [
    line(head),
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map(line),
    '',
    ...facts
      .filter((h) => h.notes.length)
      .map((h) => `- **${h.agent.name}**: ${text(h.notes.join(' '))}`),
  ].join('\n')
}

/** Where each agent reads the environment's rules and skills. */
export function renderLayout(facts) {
  return [
    '| Harness | Rules file | Workspace skills directory | Home skills directory |',
    '|---|---|---|---|',
    ...facts.map(
      (h) =>
        `| ${h.agent.name} | ${code(h.agent.rulesFile)} | ${code(h.agent.workspaceSkillDir)} | ${code(`~/${h.agent.harnessSkillDir}`)} |`,
    ),
  ].join('\n')
}
