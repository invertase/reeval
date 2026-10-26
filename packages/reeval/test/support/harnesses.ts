// Every harness the real-agent suites (contract.test.ts, e2e-real.test.ts) run, one row each.
// Adding a harness to them means adding a row here, and a case to the contract's reeval.config.ts.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { type BakedHarness, imageFor } from '@reeval/sandbox-docker'
import type { PluginPart } from '../../src/types.ts'

/** Every plugin part, for a harness that loads them all. */
export const EVERY_PART: readonly PluginPart[] = [
  'skills',
  'agents',
  'commands',
  'hooks',
  'mcp',
  'rules',
]

/** What a harness that reads Claude Code's plugin format loads: every part but rules. */
const CLAUDE_FORMAT: readonly PluginPart[] = ['skills', 'agents', 'commands', 'hooks', 'mcp']

/** Where reeval copies the probe plugin's skill, which `context` lists. */
const PLACED_PLUGIN_SKILL = /^~\/\.reeval\/plugins\/probe\/skills\/plugin-probe\/SKILL\.md$/

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
    | 'claude-code-gateway'
    | 'claude-code-vertex'
    | 'codex-gateway'
    | 'opencode-gateway'
    | 'goose-gateway'
    | 'grok-build-gateway'
    | 'claude-code-openrouter'
    | 'codex-openrouter'
    | 'opencode-openrouter'
    | 'goose-openrouter'
    | 'grok-build-openrouter'
  /**
   * `REEVAL_CONTRACT_HARNESS`, the harness it runs, when it isn't `id`: OpenCode's rows on other
   * providers than Google's, and the rows on AI Gateway and OpenRouter.
   */
  harness?: 'opencode' | 'fx' | 'claude-code' | 'codex' | 'goose' | 'pi' | 'grok-build'
  /** `REEVAL_CONTRACT_GATEWAY`: the config's `gateway` list is this gateway alone. */
  gateway?: 'vercel' | 'openrouter' | 'vertex'
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
  /**
   * Host variables the run needs besides the key (`vertex()`'s project), passed through as they
   * are: the tests start `reeval` from an allowlisted environment.
   */
  hostEnv?: string[]
  /** reeval's image for it, which the Docker tier needs built. */
  image: BakedHarness
  /** Where the placed contract skill shows up in the attempt's `context`. */
  skillContext: RegExp
  /**
   * What reeval places of a plugin on this harness: the parts its catalog entry loads
   * (`pluginParts`), which the probe plugin's `only` is narrowed to, and where the probe plugin's
   * skill shows up in `context`. The hook and subagent evals run only where `parts` has `hooks`
   * and `agents`. Unset for a row that leaves plugins to another row of its harness (to save
   * budget): its plugin evals are left out, and the plugin checks skip it, saying so.
   */
  plugin?: {
    parts: readonly PluginPart[]
    skillContext: RegExp
    /**
     * What the harness places itself, which `context` lists too: its own copy of the placed
     * plugin, what lists it, and the skills its CLI bundles. The hermetic check counts them as
     * declared.
     */
    own?: RegExp
  }
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
   * null when its requests don't name one, so the record says it's unknown; `'none named'` when the
   * gateway reads its responses but they name no model, so the record has `[]`.
   */
  wireModel: RegExp | null | 'none named'
  /**
   * What `askedModels` (the models its calls asked the gateway for, in the agent's own words) must
   * include; unset when the harness records none.
   */
  askedModel?: RegExp
  /**
   * Whether every attempt records the upstream providers that served its calls and what they
   * cost (`upstreams`, `reportedCostUsd`): true on OpenRouter, whose responses say both.
   */
  upstream?: true
}

export const harnesses: HarnessRow[] = [
  {
    id: 'fake',
    model: null,
    key: null,
    image: 'cursor',
    skillContext: /^~\/\.agents\/skills\/contract-probe\/SKILL\.md$/,
    // Plugin evals run it without a layout, so it takes every part and places plugin skills with
    // its own.
    plugin: { parts: EVERY_PART, skillContext: /^~\/\.agents\/skills\/plugin-probe\/SKILL\.md$/ },
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
    plugin: {
      parts: EVERY_PART,
      skillContext: /^~\/(.+\/)?\.agents\/skills\/plugin-probe\/SKILL\.md$/,
    },
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
    plugin: {
      parts: EVERY_PART,
      skillContext: /^~\/\.gemini\/config\/plugins\/probe\/skills\/plugin-probe\/SKILL\.md$/,
      own: /^~\/\.gemini\/config\/plugins\/probe\//,
    },
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
    plugin: { parts: CLAUDE_FORMAT, skillContext: PLACED_PLUGIN_SKILL },
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
    plugin: {
      parts: ['skills', 'agents', 'commands', 'mcp'],
      skillContext: /^~\/\.config\/opencode\/skills\/plugin-probe\/SKILL\.md$/,
    },
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
    model: 'anthropic/claude-sonnet-5-5',
    key: { name: 'ANTHROPIC_API_KEY', from: ['ANTHROPIC_API_KEY'] },
    image: 'opencode',
    skillContext: /^~\/\.config\/opencode\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['api.anthropic.com', 'mcp.exa.ai'],
    apiHost: 'api.anthropic.com',
    tokens: true,
    servedModel: /^claude-sonnet-5-5/,
    wireModel: /^claude-sonnet-5-5/,
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
    plugin: {
      parts: ['skills', 'mcp'],
      skillContext:
        /^~\/\.ai-sdk-harness\/\.harness-bootstrap\/goose\/implementation\/home\/\.config\/goose\/skills\/plugin-probe\/SKILL\.md$/,
    },
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
    plugin: {
      parts: ['skills', 'commands', 'mcp'],
      skillContext: /^~\/\.pi\/agent\/skills\/plugin-probe\/SKILL\.md$/,
    },
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
    // `codex plugin add` copies the plugin into Codex's cache, from its home marketplace; Codex
    // writes its bundled skills to ~/.codex/skills/.system as it starts.
    plugin: {
      parts: ['skills', 'mcp'],
      skillContext: PLACED_PLUGIN_SKILL,
      own: /^~\/\.(codex\/plugins\/cache\/reeval\/probe\/|agents\/plugins\/marketplace\.json$|codex\/skills\/\.system\/)/,
    },
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
    // the relay that takes fx (which ignores HTTPS_PROXY) through the egress gateway. fx sends
    // no `reasoning_effort`, and OpenAI refuses function tools without it from gpt-5.6 on.
    id: 'fx',
    model: 'gpt-5.5',
    key: { name: 'OPENAI_API_KEY', from: ['OPENAI_API_KEY'] },
    image: 'fx',
    skillContext:
      /^~\/\.ai-sdk-harness\/\.harness-bootstrap\/fx\/implementation\/home\/\.fx\/skills\/contract-probe\/SKILL\.md$/,
    plugin: {
      parts: ['skills', 'mcp'],
      skillContext:
        /^~\/\.ai-sdk-harness\/\.harness-bootstrap\/fx\/implementation\/home\/\.fx\/skills\/plugin-probe\/SKILL\.md$/,
    },
    autoHosts: ['api.openai.com'],
    apiHost: 'api.openai.com',
    tokens: true,
    // fx names no model over ACP; the gateway reads the dated snapshot the API answers with.
    servedModel: /^gpt-5\.5-\d{4}-\d{2}-\d{2}$/,
    wireModel: /^gpt-5\.5-\d{4}-\d{2}-\d{2}$/,
  },
  {
    // And on Vercel AI Gateway through `gateway: [vercel()]`: fx's own provider, with a gateway
    // model id.
    id: 'fx-gateway',
    harness: 'fx',
    gateway: 'vercel',
    model: 'google/gemini-3.8-flash',
    key: { name: 'AI_GATEWAY_API_KEY', from: ['AI_GATEWAY_API_KEY'] },
    image: 'fx',
    skillContext:
      /^~\/\.ai-sdk-harness\/\.harness-bootstrap\/fx\/implementation\/home\/\.fx\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['ai-gateway.vercel.sh'],
    apiHost: 'ai-gateway.vercel.sh',
    tokens: true,
    // Gemini's stream through fx's provider names no model, so nothing proves what served it; the
    // record keeps the model each call asked for apart, in `askedModels`.
    servedModel: null,
    wireModel: 'none named',
    askedModel: /^google\/gemini-3\.8-flash$/,
  },
  {
    // Claude Code on Vercel AI Gateway through `gateway: [vercel()]`: its base URL on Vercel, and
    // AI_GATEWAY_API_KEY brokered on Vercel's copies of Anthropic's paths.
    id: 'claude-code-gateway',
    harness: 'claude-code',
    gateway: 'vercel',
    model: 'claude-haiku-4-5',
    key: { name: 'AI_GATEWAY_API_KEY', from: ['AI_GATEWAY_API_KEY'] },
    image: 'claude-code',
    skillContext: /^~\/\.claude\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['ai-gateway.vercel.sh'],
    apiHost: 'ai-gateway.vercel.sh',
    tokens: true,
    servedModel: /claude-haiku-4-5/,
    wireModel: null,
  },
  {
    // Claude Code on Vertex AI through `gateway: [vertex()]`, the project from GOOGLE_CLOUD_PROJECT:
    // no key at all, a token minted from the host's Application Default Credentials that the
    // gateway adds to its model calls. The row's "key" is the credentials file, which must stay
    // out of the container like any key.
    id: 'claude-code-vertex',
    harness: 'claude-code',
    gateway: 'vertex',
    model: 'claude-haiku-4-5@20251001',
    key: { name: 'GOOGLE_APPLICATION_CREDENTIALS', from: ['GOOGLE_APPLICATION_CREDENTIALS'] },
    hostEnv: ['GOOGLE_CLOUD_PROJECT'],
    image: 'claude-code',
    skillContext: /^~\/\.claude\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['aiplatform.googleapis.com'],
    apiHost: 'aiplatform.googleapis.com',
    tokens: true,
    servedModel: /claude-haiku-4-5/,
    wireModel: /claude-haiku-4-5/,
  },
  {
    // Codex on Vercel AI Gateway: a Responses API provider on Vercel, the model as openai/<id>.
    id: 'codex-gateway',
    harness: 'codex',
    gateway: 'vercel',
    model: 'gpt-5.6-luna',
    key: { name: 'AI_GATEWAY_API_KEY', from: ['AI_GATEWAY_API_KEY'] },
    image: 'codex',
    skillContext: /^~\/\.agents\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['ai-gateway.vercel.sh'],
    apiHost: 'ai-gateway.vercel.sh',
    tokens: true,
    servedModel: /gpt-5\.6-luna/,
    wireModel: /gpt-5\.6-luna/,
  },
  {
    // OpenCode on Vercel AI Gateway: its own vercel provider, the model as vercel/<id>.
    id: 'opencode-gateway',
    harness: 'opencode',
    gateway: 'vercel',
    model: 'google/gemini-3.8-flash',
    key: { name: 'AI_GATEWAY_API_KEY', from: ['AI_GATEWAY_API_KEY'] },
    image: 'opencode',
    skillContext: /^~\/\.config\/opencode\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['ai-gateway.vercel.sh', 'mcp.exa.ai'],
    apiHost: 'ai-gateway.vercel.sh',
    tokens: true,
    servedModel: /gemini-3\.8-flash/,
    wireModel: /gemini-3\.8-flash/,
  },
  {
    // Goose on Vercel AI Gateway: its vercel_ai_gateway provider (OpenAI-compatible, a Bearer
    // key), the Gemini id as google/<id>, and the served model from Vercel's response.
    id: 'goose-gateway',
    harness: 'goose',
    gateway: 'vercel',
    model: 'gemini-3.8-flash',
    key: { name: 'AI_GATEWAY_API_KEY', from: ['AI_GATEWAY_API_KEY'] },
    image: 'goose',
    skillContext:
      /^~\/\.ai-sdk-harness\/\.harness-bootstrap\/goose\/implementation\/home\/\.config\/goose\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['ai-gateway.vercel.sh'],
    apiHost: 'ai-gateway.vercel.sh',
    tokens: false,
    tokensWhy:
      "its ACP server reports its last model call's usage, not the turn's, so the adapter drops it rather than record an undercount.",
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
    plugin: { parts: CLAUDE_FORMAT, skillContext: PLACED_PLUGIN_SKILL },
    autoHosts: ['api.x.ai'],
    apiHost: 'api.x.ai',
    tokens: true,
    // Its ACP server names no model; the turn records the one xAI's Responses API answered with.
    servedModel: /^grok-4\.6/,
    wireModel: /^grok-4\.6/,
  },
  {
    // Grok Build on Vercel AI Gateway: the model as a [model."xai/<id>"] table on Vercel's Chat
    // Completions API, keyed by env_key, so nothing reaches xAI's API.
    id: 'grok-build-gateway',
    harness: 'grok-build',
    gateway: 'vercel',
    model: 'grok-4.6',
    key: { name: 'AI_GATEWAY_API_KEY', from: ['AI_GATEWAY_API_KEY'] },
    image: 'grok-build',
    skillContext:
      /^~\/\.ai-sdk-harness\/\.harness-bootstrap\/grok-build\/implementation\/home\/\.grok\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['ai-gateway.vercel.sh'],
    apiHost: 'ai-gateway.vercel.sh',
    tokens: true,
    servedModel: /grok-4\.6/,
    wireModel: /grok-4\.6/,
  },
  {
    // Claude Code on OpenRouter through `gateway: [openrouter()]`: its base URL at OpenRouter's
    // Anthropic Messages API, the key as ANTHROPIC_AUTH_TOKEN (a Bearer token), the model dotted.
    id: 'claude-code-openrouter',
    harness: 'claude-code',
    gateway: 'openrouter',
    model: 'claude-haiku-4-5',
    key: { name: 'OPENROUTER_API_KEY', from: ['OPENROUTER_API_KEY'] },
    image: 'claude-code',
    skillContext: /^~\/\.claude\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['openrouter.ai'],
    apiHost: 'openrouter.ai',
    tokens: true,
    servedModel: /claude-haiku-4[.-]5/,
    wireModel: /claude-haiku-4[.-]5/,
    upstream: true,
  },
  {
    // Codex on OpenRouter: a Responses API provider there, the model as openai/<id>.
    id: 'codex-openrouter',
    harness: 'codex',
    gateway: 'openrouter',
    model: 'gpt-5.6-luna',
    key: { name: 'OPENROUTER_API_KEY', from: ['OPENROUTER_API_KEY'] },
    image: 'codex',
    skillContext: /^~\/\.agents\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['openrouter.ai'],
    apiHost: 'openrouter.ai',
    tokens: true,
    servedModel: /gpt-5\.6-luna/,
    wireModel: /gpt-5\.6-luna/,
    upstream: true,
  },
  {
    // OpenCode on OpenRouter: its own openrouter provider, the model as openrouter/<id>.
    id: 'opencode-openrouter',
    harness: 'opencode',
    gateway: 'openrouter',
    model: 'google/gemini-3.8-flash',
    key: { name: 'OPENROUTER_API_KEY', from: ['OPENROUTER_API_KEY'] },
    image: 'opencode',
    skillContext: /^~\/\.config\/opencode\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['openrouter.ai', 'mcp.exa.ai'],
    apiHost: 'openrouter.ai',
    tokens: true,
    servedModel: /gemini-3\.8-flash/,
    wireModel: /gemini-3\.8-flash/,
    upstream: true,
  },
  {
    // Goose on OpenRouter: its openrouter provider (Chat Completions, a Bearer key), the Gemini
    // id as google/<id>.
    id: 'goose-openrouter',
    harness: 'goose',
    gateway: 'openrouter',
    model: 'gemini-3.8-flash',
    key: { name: 'OPENROUTER_API_KEY', from: ['OPENROUTER_API_KEY'] },
    image: 'goose',
    skillContext:
      /^~\/\.ai-sdk-harness\/\.harness-bootstrap\/goose\/implementation\/home\/\.config\/goose\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['openrouter.ai'],
    apiHost: 'openrouter.ai',
    tokens: false,
    tokensWhy:
      "its ACP server reports its last model call's usage, not the turn's, so the adapter drops it rather than record an undercount.",
    servedModel: /gemini-3\.8-flash/,
    wireModel: /gemini-3\.8-flash/,
    upstream: true,
  },
  {
    // Grok Build on OpenRouter: the model as a [model."x-ai/<id>"] table on OpenRouter's Chat
    // Completions API, keyed by env_key, so nothing reaches xAI's API.
    id: 'grok-build-openrouter',
    harness: 'grok-build',
    gateway: 'openrouter',
    model: 'grok-4.6',
    key: { name: 'OPENROUTER_API_KEY', from: ['OPENROUTER_API_KEY'] },
    image: 'grok-build',
    skillContext:
      /^~\/\.ai-sdk-harness\/\.harness-bootstrap\/grok-build\/implementation\/home\/\.grok\/skills\/contract-probe\/SKILL\.md$/,
    autoHosts: ['openrouter.ai'],
    apiHost: 'openrouter.ai',
    tokens: true,
    servedModel: /grok-4\.6/,
    wireModel: /grok-4\.6/,
    upstream: true,
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

/**
 * The host environment for `reeval run` on this row: the key under its own name, its `hostEnv`,
 * and the row's pick.
 */
export function rowEnv(row: HarnessRow): NodeJS.ProcessEnv {
  const key = keyOf(row)
  return {
    ...(row.id === 'fake' ? {} : { REEVAL_CONTRACT_HARNESS: harnessOf(row) }),
    ...(row.model ? { REEVAL_CONTRACT_MODEL: row.model } : {}),
    ...(row.gateway ? { REEVAL_CONTRACT_GATEWAY: row.gateway } : {}),
    ...(row.plugin ? { REEVAL_CONTRACT_PLUGIN_PARTS: row.plugin.parts.join(',') } : {}),
    ...(row.key && key ? { [row.key.name]: key } : {}),
    ...Object.fromEntries(
      (row.hostEnv ?? []).flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
    ),
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
  const unset = (row.hostEnv ?? []).filter((name) => !process.env[name])
  if (unset.length) {
    throw new Error(
      `${unset.join(' and ')} isn't set, and REEVAL_TEST_REAL=1 asks for real ${row.id}: set it, or leave ${row.id} out of REEVAL_CONTRACT_HARNESSES`,
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
