// Every harness the real-agent suites (contract.test.ts, e2e-real.test.ts) run, one row each.
// Adding a harness to them means adding a row here, and a case to the contract's reeval.config.ts.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { type BakedHarness, imageFor } from '@reeval/sandbox-docker'

export type HarnessRow = {
  /** The name in test titles, `REEVAL_CONTRACT_HARNESSES` and the capture directory. */
  id:
    | 'fake'
    | 'cursor'
    | 'antigravity'
    | 'claude-code'
    | 'opencode'
    | 'opencode-anthropic'
    | 'opencode-openai'
    | 'goose'
    | 'pi'
    | 'codex'
    | 'grok-build'
    | 'fx'
    | 'fx-gateway'
  /**
   * `REEVAL_CONTRACT_HARNESS`, the harness it runs, when it isn't `id`: OpenCode's rows on other
   * providers than Google's, and fx's on AI Gateway.
   */
  harness?: 'opencode' | 'fx'
  /**
   * Why the row is skipped unless `REEVAL_CONTRACT_HARNESSES` names it, such as a key CI doesn't
   * have yet.
   */
  gated?: string
  /** The cheapest model that does the job; null for the fake agent. */
  model: string | null
  /**
   * The host variable the harness authenticates with, and the variables it's read from, in order
   * (the first that's set). Null for the fake agent, which needs no key.
   */
  key: { name: string; from: string[] } | null
  /** reeval's image for it, which the Docker tier needs built. */
  image: BakedHarness
  /** Where the placed contract skill shows up in the attempt's `context`. */
  skillContext: RegExp
  /** What a restricted policy allows automatically for it. */
  autoHosts: string[]
  /** A host it reaches on every turn; null for the fake agent, which reaches none. */
  apiHost: string | null
  /** False for a harness with no MCP client: its MCP attempts must be refused, not run. */
  mcp?: false
  /** Whether it reports token usage for each turn; checked either way. */
  tokens: boolean
  /** Why a real harness reports none, for the harness matrix in the README and docs. */
  tokensWhy?: string
  /** What every turn's `model` (the model the harness says served it) looks like; null: none. */
  servedModel: RegExp | null
  /**
   * Why the turns don't record the model `servedModel` expects yet, while the contract's check of
   * it fails on real runs; the harness matrix shows it as missing. Delete it with the fix.
   */
  servedModelGap?: string
  /**
   * What `servedModels` (the models its API requests named, seen by the gateway) must include;
   * null when its requests don't name one, so the record says it's unknown.
   */
  wireModel: RegExp | null
}

export const harnesses: HarnessRow[] = [
  {
    id: 'fake',
    model: null,
    key: null,
    image: 'cursor',
    skillContext: /^~\/\.agents\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['api2.cursor.sh', '*.cursor.sh'],
    apiHost: null,
    tokens: false,
    servedModel: null,
    wireModel: null,
  },
  {
    id: 'cursor',
    model: 'composer-2.5',
    key: { name: 'CURSOR_API_KEY', from: ['CURSOR_API_KEY'] },
    image: 'cursor',
    skillContext: /^~\/(.+\/)?\.agents\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['api2.cursor.sh', '*.cursor.sh'],
    apiHost: 'api2.cursor.sh',
    tokens: true,
    // The SDK reports the resolved model with its parameters, e.g. composer-2.5[fast=false].
    servedModel: /^composer-2\.5/,
    wireModel: null,
  },
  {
    id: 'antigravity',
    model: 'gemini-3.8-flash-low',
    key: { name: 'GEMINI_API_KEY', from: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'] },
    image: 'antigravity',
    skillContext: /^~\/\.gemini\/config\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['generativelanguage.googleapis.com'],
    apiHost: 'generativelanguage.googleapis.com',
    tokens: true,
    servedModel: /^gemini-3\.8-flash/,
    wireModel: /^gemini-3\.8-flash$/,
  },
  {
    id: 'claude-code',
    model: 'claude-haiku-4-5',
    key: { name: 'ANTHROPIC_API_KEY', from: ['ANTHROPIC_API_KEY'] },
    image: 'claude-code',
    skillContext: /^~\/\.claude\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['api.anthropic.com', '*.anthropic.com'],
    apiHost: 'api.anthropic.com',
    tokens: true,
    servedModel: /^claude-haiku-4-5/,
    wireModel: null,
  },
  {
    id: 'opencode',
    model: 'google/gemini-3.8-flash',
    key: {
      name: 'GOOGLE_GENERATIVE_AI_API_KEY',
      from: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
    },
    image: 'opencode',
    skillContext: /^~\/\.config\/opencode\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['generativelanguage.googleapis.com', 'mcp.exa.ai'],
    apiHost: 'generativelanguage.googleapis.com',
    tokens: true,
    // Its ACP server names no model; the turn records the one the gateway saw it request.
    servedModel: /^gemini-3\.8-flash$/,
    wireModel: /^gemini-3\.8-flash$/,
  },
  {
    // OpenCode on another provider: Anthropic's key, in x-api-key, and its served model from the
    // response.
    id: 'opencode-anthropic',
    harness: 'opencode',
    model: 'anthropic/claude-haiku-4-5',
    key: { name: 'ANTHROPIC_API_KEY', from: ['ANTHROPIC_API_KEY'] },
    image: 'opencode',
    skillContext: /^~\/\.config\/opencode\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['api.anthropic.com', 'mcp.exa.ai'],
    apiHost: 'api.anthropic.com',
    tokens: true,
    servedModel: /^claude-haiku-4-5/,
    wireModel: /^claude-haiku-4-5/,
  },
  {
    // And OpenAI's: a Bearer key, the Responses API over HTTP (not OpenCode's WebSocket), and
    // the dated model and effort from the response.
    id: 'opencode-openai',
    harness: 'opencode',
    model: 'openai/gpt-5.4-mini',
    key: { name: 'OPENAI_API_KEY', from: ['OPENAI_API_KEY'] },
    image: 'opencode',
    skillContext: /^~\/\.config\/opencode\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['api.openai.com', 'mcp.exa.ai'],
    apiHost: 'api.openai.com',
    tokens: true,
    servedModel: /^gpt-5\.4-mini-\d{4}-\d{2}-\d{2}\[effort=\w+\]$/,
    wireModel: /^gpt-5\.4-mini-\d{4}-\d{2}-\d{2}\[effort=\w+\]$/,
  },
  {
    id: 'goose',
    model: 'gemini-3.8-flash',
    key: {
      name: 'GOOGLE_GENERATIVE_AI_API_KEY',
      from: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
    },
    image: 'goose',
    skillContext:
      /^~\/\.ai-sdk-harness\/\.harness-bootstrap\/goose\/implementation\/home\/\.config\/goose\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['generativelanguage.googleapis.com'],
    apiHost: 'generativelanguage.googleapis.com',
    tokens: false,
    tokensWhy:
      "its ACP server reports its last model call's usage, not the turn's, so the adapter drops it rather than record an undercount.",
    // Its ACP server names no model; the turn records the one the gateway saw it request.
    servedModel: /^gemini-3\.8-flash$/,
    wireModel: /^gemini-3\.8-flash$/,
  },
  {
    id: 'pi',
    model: 'gemini-3.8-flash',
    key: {
      name: 'GOOGLE_GENERATIVE_AI_API_KEY',
      from: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
    },
    image: 'pi',
    skillContext: /^~\/\.pi\/agent\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['generativelanguage.googleapis.com'],
    apiHost: 'generativelanguage.googleapis.com',
    tokens: true,
    servedModel: /^gemini-3\.8-flash$/,
    wireModel: /^gemini-3\.8-flash$/,
  },
  {
    id: 'codex',
    model: 'gpt-5.6-luna',
    key: { name: 'OPENAI_API_KEY', from: ['OPENAI_API_KEY'] },
    image: 'codex',
    skillContext: /^~\/\.agents\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['api.openai.com'],
    apiHost: 'api.openai.com',
    tokens: true,
    // The Responses API names the model, undated, and the effort Codex resolved for it; both come
    // from the response, via the gateway. `effort=medium` is its catalog default: a model Codex's
    // catalog doesn't list gets no effort (`effort=none`) and no apply_patch tool.
    servedModel: /^gpt-5\.6-luna\[effort=medium\]$/,
    wireModel: /^gpt-5\.6-luna\[effort=medium\]$/,
  },
  {
    // fx on OpenAI's Chat Completions API, as an fx configured provider: a Bearer key, through
    // the relay that takes fx (which ignores HTTPS_PROXY) through the egress gateway. Not a
    // reasoning model (fx sends them `max_tokens`), and not gpt-4.1-mini, which hands the skill
    // probe to an fx subagent that often reports it done without writing the proof.
    id: 'fx',
    model: 'gpt-4.1',
    key: { name: 'OPENAI_API_KEY', from: ['OPENAI_API_KEY'] },
    image: 'fx',
    skillContext:
      /^~\/\.ai-sdk-harness\/\.harness-bootstrap\/fx\/implementation\/home\/\.fx\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['api.openai.com'],
    apiHost: 'api.openai.com',
    tokens: true,
    // fx names no model over ACP; the gateway reads the dated snapshot the API answers with.
    servedModel: /^gpt-4\.1-\d{4}-\d{2}-\d{2}$/,
    wireModel: /^gpt-4\.1-\d{4}-\d{2}-\d{2}$/,
  },
  {
    // And on Vercel AI Gateway, fx's own provider, with a gateway model id.
    id: 'fx-gateway',
    harness: 'fx',
    gated:
      'no AI_GATEWAY_API_KEY repository secret yet; name fx-gateway in REEVAL_CONTRACT_HARNESSES to run it',
    model: 'google/gemini-3.8-flash',
    key: { name: 'AI_GATEWAY_API_KEY', from: ['AI_GATEWAY_API_KEY'] },
    image: 'fx',
    skillContext:
      /^~\/\.ai-sdk-harness\/\.harness-bootstrap\/fx\/implementation\/home\/\.fx\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['ai-gateway.vercel.sh'],
    apiHost: 'ai-gateway.vercel.sh',
    tokens: true,
    servedModel: /gemini-3\.8-flash/,
    wireModel: /gemini-3\.8-flash/,
  },
  {
    id: 'grok-build',
    model: 'grok-4.6',
    key: { name: 'XAI_API_KEY', from: ['XAI_API_KEY'] },
    image: 'grok-build',
    skillContext:
      /^~\/\.ai-sdk-harness\/\.harness-bootstrap\/grok-build\/implementation\/home\/\.grok\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['api.x.ai'],
    apiHost: 'api.x.ai',
    tokens: true,
    // Its ACP server names no model; the turn records the one xAI's Responses API answered with.
    servedModel: /^grok-4\.6/,
    wireModel: /^grok-4\.6/,
  },
]

/** The row's key from the host, or undefined when none of its variables is set. */
export const keyOf = (row: HarnessRow) =>
  row.key?.from.map((name) => process.env[name]).find(Boolean)

/** The harness a row runs: its `harness`, or the one its id names. */
export const harnessOf = (row: HarnessRow) => row.harness ?? row.id

/**
 * The cell's harness id in attempt ids: `cursor:composer-2.5`, `opencode:claude-haiku-4-5` (the
 * model's last segment), or `fake`.
 */
export const cellOf = (row: HarnessRow) =>
  row.model ? `${harnessOf(row)}:${row.model.split('/').at(-1)}` : row.id

const imageBuilt = (ref: string) => {
  try {
    execFileSync('docker', ['image', 'inspect', ref], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Why a row doesn't run here, or false. Real rows run only with `REEVAL_TEST_REAL=1` (they spend
 * money), and skip without it, saying so; asked for, a row without its key runs and fails in
 * `reserveAttempts`, naming the variable. `REEVAL_CONTRACT_HARNESSES=cursor,…` picks rows. A missing
 * image fails instead under `REEVAL_TEST_REQUIRE_DOCKER=1`, as the Docker tier does.
 */
export function skipRow(row: HarnessRow): string | false {
  const only = process.env.REEVAL_CONTRACT_HARNESSES?.split(',')
  if (only && !only.includes(row.id)) return `REEVAL_CONTRACT_HARNESSES=${only.join(',')}`
  if (row.gated && !only) return row.gated
  if (row.key) {
    if (process.env.REEVAL_TEST_REAL !== '1') return 'set REEVAL_TEST_REAL=1 to run real agents'
    if (!keyOf(row)) return false
  }
  if (process.env.REEVAL_TEST_REQUIRE_DOCKER === '1') return false
  if (!imageBuilt(imageFor(row.image)))
    return `needs Docker and ${imageFor(row.image)} (reeval image build)`
  return false
}

/** The host environment for `reeval run` on this row: the key under its own name, and the row's pick. */
export function rowEnv(row: HarnessRow): NodeJS.ProcessEnv {
  const key = keyOf(row)
  return {
    ...(row.id === 'fake' ? {} : { REEVAL_CONTRACT_HARNESS: harnessOf(row) }),
    ...(row.model ? { REEVAL_CONTRACT_MODEL: row.model } : {}),
    ...(row.key && key ? { [row.key.name]: key } : {}),
    ...(process.env.REEVAL_RAW_TRANSCRIPT
      ? { REEVAL_RAW_TRANSCRIPT: process.env.REEVAL_RAW_TRANSCRIPT }
      : {}),
  }
}

/** The rolling hash `scan.mjs` uses: base 257, mod 2^32, over the bytes. */
export function rollingHash(bytes: Uint8Array): number {
  let h = 0
  for (const b of bytes) h = (Math.imul(h, 257) + b) >>> 0
  return h
}

/**
 * The scanner's targets for a value: its raw and base64 forms, each as a sha256, a length and a
 * rolling hash. The value itself never goes into the sandbox.
 */
export function scanTargets(value: string): string {
  const forms: Array<[string, Buffer]> = [
    ['raw', Buffer.from(value)],
    ['base64', Buffer.from(Buffer.from(value).toString('base64'))],
  ]
  return JSON.stringify(
    forms.map(([form, bytes]) => ({
      form,
      len: bytes.length,
      roll: rollingHash(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
  )
}

/**
 * The hard cap on real attempts across every suite of one CI job: each real row reserves what it
 * may start in `REEVAL_REAL_LEDGER` (a file, one number per line) before it runs, and fails without
 * starting anything when that would take the job over `REEVAL_REAL_ATTEMPT_BUDGET`. Unset, no cap
 * (local runs); each reeval run's own `budget.attempts` still holds. A real row without its key fails
 * here, before anything starts: asking for real agents (`REEVAL_TEST_REAL=1`) and getting a skip would
 * pass a nightly that tested nothing.
 */
export function reserveAttempts(row: HarnessRow, attempts: number, what: string): void {
  if (row.key && !keyOf(row)) {
    throw new Error(
      `${row.key.from.join(' or ')} isn't set, and REEVAL_TEST_REAL=1 asks for real ${row.id}: set it, or leave ${row.id} out of REEVAL_CONTRACT_HARNESSES`,
    )
  }
  const budget = Number(process.env.REEVAL_REAL_ATTEMPT_BUDGET)
  const ledger = process.env.REEVAL_REAL_LEDGER
  if (!row.key || !budget || !ledger) return
  const spent = existsSync(ledger)
    ? readFileSync(ledger, 'utf8')
        .split('\n')
        .filter(Boolean)
        .reduce((sum, line) => sum + Number(line.split(' ')[0]), 0)
    : 0
  if (spent + attempts > budget) {
    throw new Error(
      `${what} on ${row.id} would start ${attempts} real attempts, over the job's budget of ${budget} (${spent} reserved): raise the job's REEVAL_REAL_ATTEMPT_BUDGET (contract.yml, or real.yml's smoke job) if the suite grew on purpose`,
    )
  }
  appendFileSync(ledger, `${attempts} ${what} ${row.id}\n`)
}
