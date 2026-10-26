// The harness feature matrix in the docs' Harnesses guide, from the code: the
// harness catalog (src/harness/agents.ts), each adapter's builtin tool catalog, and the rows of
// the harness contract (test/support/harnesses.ts), whose real runs check tokens and the served
// model. Every note is tied to the fact it explains, so it goes when that fact changes.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const src = join(root, 'packages/reeval/src')
const { AGENTS, agentFor, gooseMcpServers, refusedMcp } = await import(
  join(src, 'harness/agents.ts')
)
const { OPENCODE_PROVIDERS } = await import(
  join(root, 'packages/harness-opencode/src/opencode-providers.ts')
)
const { InfraError } = await import(join(src, 'sandbox/types.ts'))
const { harnesses } = await import(join(root, 'packages/reeval/test/support/harnesses.ts'))

const TRANSPORTS = ['stdio', 'http', 'sse']
const PROBE = {
  stdio: { transport: 'stdio', command: 'probe', args: [], env: {} },
  http: { transport: 'http', url: 'https://mcp.example/mcp', headers: {} },
  sse: { transport: 'sse', url: 'https://mcp.example/sse', headers: {} },
}

/** Whether the agent takes an MCP server of each transport, and when reeval refuses one it can't. */
function mcpSupport(kind, agent) {
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
    const atPlan = refused && !!refusedMcp({ kind, model: 'probe' }, layers)
    out[transport] = { ok: !refused, atPlan }
  }
  return out
}

/** The web events reeval records for an agent: its adapter's tools that the transcript maps to them. */
async function webEvents(kind, agent, model) {
  const adapter = await agent.adapter({
    auth: { [agent.credential]: 'probe' },
    descriptor: { kind, model },
    model,
    plugins: [],
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

/** Harnesses the docs leave out: no page, no matrix or layout row. Their code checks still run. */
const EXCLUDED_KINDS = []

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
    `MCP servers go in its ${code('config.yaml')} file as enabled extensions, not over ACP, where they start disabled.`,
  (h) => !h.row.tokens && `No tokens recorded: ${h.row.tokensWhy}`,
  (h) =>
    !h.row.servedModel &&
    h.row.wireModel &&
    `Served model from the gateway's requests only (the record's ${code('servedModels')}); each turn's ${code('model')} is null.`,
  (h) => h.row.servedModelGap && `No served model recorded: ${h.row.servedModelGap}`,
  (h) =>
    h.row.servedModel &&
    !h.row.servedModelGap &&
    !h.row.wireModel &&
    `Served model as the harness reports it: its API requests don't name one, so the record's ${code('servedModels')} is null.`,
  (h) =>
    h.agent.unreported &&
    h.kind === 'cursor' &&
    `Its SDK leaves web search and fetch calls out of the stream; reeval recovers them from the stored conversation, and a turn it can't recover is marked ${code('unreported')} so web matchers refuse it.`,
  (h) =>
    h.kind === 'opencode' &&
    h.web.search &&
    `Its web searches go to Exa's hosted MCP server, keyless, from the sandbox: ${code('mcp.exa.ai')} is one of its automatic hosts.`,
  (h) =>
    h.kind === 'opencode' &&
    `MCP servers go in its config with Code Mode off, not over ACP, where OpenCode offers them only through its ${code('execute')} tool; the first prompt waits until they've connected.`,
  (h) =>
    h.agent.modelResponses &&
    h.kind === 'codex' &&
    `Served model and reasoning effort from each API response, which the gateway reads, such as ${code('<model>[effort=medium]')}: its CLI doesn't report them.`,
  (h) =>
    h.agent.modelResponses &&
    h.kind === 'grok-build' &&
    `Served model from each API response, which the gateway reads: its CLI doesn't report it.`,
  (h) =>
    h.kind === 'codex' &&
    h.web.search &&
    `Its web searches and the pages it opens run on OpenAI's side, so a restricted egress policy doesn't limit them; each is in the transcript.`,
  (h) =>
    h.agent.expectedBlocked &&
    !h.agent.expectedBlocked.withPlugins &&
    `It tries ${list(h.agent.expectedBlocked.hosts.map(code))} (${h.agent.expectedBlocked.why}); a restricted egress policy refuses ${h.agent.expectedBlocked.hosts.length > 1 ? 'them' : 'it'} and records ${h.agent.expectedBlocked.hosts.length > 1 ? 'them' : 'it'} under the record's ${code('egress.expectedBlocked')}.`,
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
    const excluded = EXCLUDED_KINDS.includes(kind)
    const page = `integrations/agents/${kind}`
    if (!excluded && !existsSync(join(root, 'docs', `${page}.mdx`)))
      problems.push(`harness ${kind} has no docs/${page}.mdx`)
    const credential = agentFor({ kind, model: row.model }).credential
    if (row.key?.name !== credential) {
      problems.push(
        `${kind}: the contract row's key is ${row.key?.name}, the catalog's ${credential}`,
      )
    }
    if (!!row.wireModel !== !!agent.servedModel) {
      problems.push(
        `${kind}: the contract row's wireModel and the catalog's servedModel disagree on whether its requests name the model`,
      )
    }
    if (!row.tokens && !row.tokensWhy)
      problems.push(`${kind}: a contract row with tokens: false needs tokensWhy`)
    const mcp = mcpSupport(kind, agent)
    if ((row.mcp !== false) !== mcp.stdio.ok) {
      problems.push(`${kind}: the contract row's mcp and the catalog disagree on stdio MCP servers`)
    }
    if (String(row.plugin?.parts ?? []) !== String(agent.pluginParts)) {
      problems.push(
        `${kind}: the contract row's plugin.parts (${row.plugin?.parts ?? 'unset'}) and the catalog's pluginParts (${agent.pluginParts}) disagree`,
      )
    }
    if (excluded) continue
    const web = await webEvents(kind, agentFor({ kind, model: row.model }), row.model)
    const h = { kind, agent, row, page, mcp, web }
    h.notes = NOTES.map((note) => note(h)).filter(Boolean)
    facts.push(h)
  }
  for (const row of harnesses) {
    if (row.id !== 'fake' && !AGENTS[row.harness ?? row.id])
      problems.push(`contract row ${row.id} isn't in AGENTS`)
    if (row.harness) {
      const credential = agentFor({
        kind: row.harness,
        model: row.model,
        ...(row.gateway ? { gateway: row.gateway } : {}),
      }).credential
      if (row.key?.name !== credential)
        problems.push(
          `${row.id}: the contract row's key is ${row.key?.name}, the catalog's ${credential}`,
        )
    }
  }
  return { facts, problems }
}

const yes = (ok) => (ok ? '✓' : '✗')

/**
 * The matrix and its notes. `href` turns a docs page (`integrations/agents/pi`) into a link for
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
    `MCP ${code('http')}`,
    `MCP ${code('sse')}`,
    'Tokens',
    'Served model',
    'Web search events',
    'Web fetch events',
    'Sandbox',
  ]
  const rows = facts.map((h) => [
    `[${h.agent.name}](${href(h.page)})`,
    h.agent.forModel ? "The model's provider's" : code(h.agent.credential),
    yes(h.agent.endpoints.length > 0),
    code(h.agent.rulesFile),
    yes(!!h.agent.workspaceSkillDir),
    yes(!!h.agent.harnessSkillDir),
    ...TRANSPORTS.map((t) => yes(h.mcp[t].ok)),
    yes(h.row.tokens),
    h.row.servedModel && !h.row.servedModelGap ? '✓' : h.row.wireModel ? 'partial' : '✗',
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

const cell = (s) => s.replaceAll('|', '\\|')

/** Every provider OpenCode runs on in reeval: its model ids, key, the header it goes in, its hosts. */
export function renderOpenCodeProviders() {
  return [
    '| Provider | Model ids | Key | Header | Hosts |',
    '|---|---|---|---|---|',
    ...OPENCODE_PROVIDERS.map((p) => {
      const headers = p.headers.map((h) =>
        code(h.scheme === 'bearer' ? 'Authorization: Bearer' : h.name),
      )
      const hosts = [...new Set(p.endpoints.map((e) => e.host))].map(code)
      return `| ${cell(p.name)} | ${code(`${p.id}/…`)} | ${code(p.env)} | ${headers.join(', ')} | ${hosts.join(', ')} |`
    }),
  ].join('\n')
}
