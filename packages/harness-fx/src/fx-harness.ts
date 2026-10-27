import type { HarnessV1, HarnessV1AuthenticationEnvironment } from '@ai-sdk/harness'
import {
  createCredentialRequestTransformation,
  isHarnessAuthenticationEnvironment,
} from '@ai-sdk/harness/utils'
import { createACP } from '@ai-sdk/harness-acp'
import { FxStreamTranslator } from './fx-stream.ts'
import { FX_BUILTIN_TOOLS, type FxBuiltinTools } from './fx-tools.ts'

export const FX_HARNESS_ID = 'fx'
/** The fx release the bootstrap installs, checked against its published sha256s. */
export const FX_CLI_VERSION = '0.0.14'
export const FX_CLI_SHA256 = {
  x86_64: '731c1914fc2d497a10583f4416f8382c192e4897d6a0b4f713d6194455a8548b',
  aarch64: '9f5cfbac1728fffddc2d5d874d1f7fe8d34f179e1bc86fb2e67a6e75074e53f3',
} as const

/**
 * Where a model runs: Vercel AI Gateway for a gateway id (`anthropic/claude-sonnet-5`), fx's own
 * provider, or OpenAI's Chat Completions API for a bare OpenAI id (`gpt-5.5`), as an fx
 * configured provider. Each takes one key, sent as a bearer token.
 */
export const FX_PROVIDERS = {
  gateway: { credential: 'AI_GATEWAY_API_KEY', url: 'https://ai-gateway.vercel.sh' },
  openai: { credential: 'OPENAI_API_KEY', url: 'https://api.openai.com' },
} as const
export type FxProvider = keyof typeof FX_PROVIDERS

/** The provider a model id names: a gateway id has a `/`, an OpenAI id doesn't. */
export const fxProviderOf = (model: string): FxProvider =>
  model.includes('/') ? 'gateway' : 'openai'

/** Where harness-placed skills go, under the private home `@ai-sdk/harness-acp` gives fx. */
export const FX_HOME_SKILLS_DIR = '.fx/skills'
/** The repo skill directory fx reads. */
export const FX_WORKSPACE_SKILLS_DIR = '.fx/skills'

/** Headless and pinned: no self-upgrade, no sounds, no colour. */
export const FX_QUIET_ENV = {
  FX_AUTO_UPGRADE: '0',
  FX_SOUND: '0',
  NO_COLOR: '1',
} as const

/**
 * fx's HTTP client ignores `HTTPS_PROXY`, so it can't reach the sandbox's egress gateway itself.
 * It talks plain HTTP to this relay on localhost (fx allows `http://` there), which forwards each
 * request with Node's `fetch`, which honours the proxy (`NODE_USE_ENV_PROXY`) and the gateway's CA.
 *
 * On a Chat Completions call it also adds `FX_RELAY_EFFORT` as `reasoning_effort`, which fx sends
 * a configured provider none of. With `FX_RELAY_GOOGLE=1` it makes Google's Chat Completions
 * stream one fx reads: each tool call's thought signature, which Gemini needs back on the next call
 * and fx drops, is kept by call id and put back (or Google's placeholder for one it never saw); a
 * tool call gets the `index` and the finish the `tool_calls` reason fx needs; and the thinking
 * tokens Google counts in `total_tokens` but not `completion_tokens` (which fx refuses) join
 * `completion_tokens` as its `reasoning_tokens`.
 */
export const FX_RELAY_PORT = 47823
const FX_RELAY = `import { createServer } from 'node:http'
import { Readable, Transform } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { writeFileSync } from 'node:fs'
const [port, upstream, ready] = process.argv.slice(2)
const effort = process.env.FX_RELAY_EFFORT
const google = process.env.FX_RELAY_GOOGLE === '1'
const signatures = new Map()
const drop = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive'])
const chat = (req) => req.method === 'POST' && /\\/chat\\/completions(\\?|$)/.test(req.url)
async function request(req) {
  let text = ''
  req.setEncoding('utf8')
  for await (const piece of req) text += piece
  const body = JSON.parse(text)
  if (effort) body.reasoning_effort = effort
  if (google) {
    for (const message of body.messages ?? []) {
      for (const call of message.tool_calls ?? []) {
        call.extra_content ??= { google: { thought_signature: signatures.get(call.id) ?? 'skip_thought_signature_validator' } }
      }
    }
  }
  return JSON.stringify(body)
}
function chunk(data, state) {
  const json = JSON.parse(data)
  for (const choice of json.choices ?? []) {
    for (const call of choice.delta?.tool_calls ?? []) {
      const signature = call.extra_content?.google?.thought_signature
      if (signature && call.id) signatures.set(call.id, signature)
      const id = call.id ?? state.last
      if (!state.calls.has(id)) state.calls.set(id, state.calls.size)
      state.last = id
      call.index ??= state.calls.get(id)
    }
    if (choice.finish_reason === 'stop' && state.calls.size) choice.finish_reason = 'tool_calls'
  }
  const usage = json.usage
  const thoughts = usage ? usage.total_tokens - usage.prompt_tokens - usage.completion_tokens : 0
  if (thoughts > 0) {
    usage.completion_tokens += thoughts
    usage.completion_tokens_details = { ...usage.completion_tokens_details, reasoning_tokens: thoughts }
  }
  return JSON.stringify(json)
}
function stream() {
  const state = { calls: new Map(), last: undefined }
  const decoder = new StringDecoder('utf8')
  let rest = ''
  const line = (text) => {
    if (!text.startsWith('data: {')) return text
    try { return 'data: ' + chunk(text.slice(6), state) } catch { return text }
  }
  return new Transform({
    transform(data, _, done) {
      const lines = (rest + decoder.write(data)).split('\\n')
      rest = lines.pop()
      done(null, lines.map((each) => line(each) + '\\n').join(''))
    },
    flush(done) {
      rest += decoder.end()
      done(null, rest ? line(rest) : '')
    },
  })
}
const server = createServer(async (req, res) => {
  try {
    const headers = Object.entries(req.headers).filter(([k]) => !drop.has(k))
    const rewrite = chat(req) && (google || effort)
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : rewrite ? await request(req) : Readable.toWeb(req)
    const r = await fetch(upstream + req.url, { method: req.method, headers, body, duplex: 'half' })
    const out = {}
    r.headers.forEach((v, k) => { if (k !== 'content-encoding' && k !== 'content-length') out[k] = v })
    res.writeHead(r.status, out)
    const events = google && chat(req) && /event-stream/.test(r.headers.get('content-type') ?? '')
    if (r.body) (events ? Readable.fromWeb(r.body).pipe(stream()) : Readable.fromWeb(r.body)).pipe(res)
    else res.end()
  } catch (error) {
    res.writeHead(502, { 'content-type': 'text/plain' })
    res.end(String(error))
  }
})
server.on('error', (error) => {
  if (error.code !== 'EADDRINUSE') throw error
  writeFileSync(ready, '')
  process.exit(0)
})
server.listen(Number(port), '127.0.0.1', () => writeFileSync(ready, ''))
`

/** `fx-acp`: starts the relay to the model's provider (`FX_RELAY_UPSTREAM`), waits for it, then becomes `fx acp`. */
const FX_LAUNCH = `#!/bin/bash
bin="$(dirname "$0")"
ready="$(mktemp -u)"
node "$bin/fx-relay.mjs" ${FX_RELAY_PORT} "$FX_RELAY_UPSTREAM" "$ready" >/dev/null 2>&1 &
for _ in $(seq 100); do [ -e "$ready" ] && break; sleep 0.05; done
exec "$bin/fx" acp
`

/** Downloads the pinned release for the sandbox's arch and checks its sha256, and writes the relay. */
export const FX_INSTALL_COMMAND = `case "$(uname -m)" in
  x86_64|amd64) arch=x86_64 sha=${FX_CLI_SHA256.x86_64} ;;
  aarch64|arm64) arch=aarch64 sha=${FX_CLI_SHA256.aarch64} ;;
  *) echo "fx has no release for $(uname -m)" >&2; exit 1 ;;
esac
curl -fsSL --retry 3 -o fx.tar.gz "https://github.com/vercel-labs/fx/releases/download/v${FX_CLI_VERSION}/fx-linux-$arch.tar.gz"
echo "$sha  fx.tar.gz" | sha256sum -c -
mkdir -p "$HOME/.local/bin"
tar -xzf fx.tar.gz -C "$HOME/.local/bin" fx
rm fx.tar.gz
cat > "$HOME/.local/bin/fx-relay.mjs" <<'FX_RELAY'
${FX_RELAY}FX_RELAY
cat > "$HOME/.local/bin/fx-acp" <<'FX_LAUNCH'
${FX_LAUNCH}FX_LAUNCH
chmod +x "$HOME/.local/bin/fx-acp"`

const relayUrl = `http://127.0.0.1:${FX_RELAY_PORT}`
/** AI Gateway's language-model path, where fx 0.0.14 sends each model call. */
export const FX_GATEWAY_CHAT_PATH = '/v4/ai/language-model'

export type FxHarnessSettings = {
  /**
   * The model's provider's key only (see {@link FX_PROVIDERS}); empty on Vertex AI. The host
   * environment is never read.
   */
  readonly auth: HarnessV1AuthenticationEnvironment
  /**
   * A gateway id (`anthropic/claude-sonnet-5`) or a bare OpenAI id (`gpt-5.5`); on Vertex AI, the
   * Chat Completions endpoint's id (`google/gemini-3.8-flash`).
   */
  readonly model: string
  /**
   * Vertex AI's OpenAI-compatible Chat Completions endpoint in this project and region instead,
   * as the configured provider `vertex`, with no credential: whoever runs the sandbox adds the
   * token to its calls.
   */
  readonly vertex?: FxVertex
  /** Sent as `reasoning_effort` on each Chat Completions call (Vertex AI's or OpenAI's). */
  readonly effort?: string
  /** MCP servers in ACP's `McpServer` shape, keyed by name, passed on `session/new`. */
  readonly mcpServers?: Record<string, Record<string, unknown>>
  /** Refuse a sandbox that can't broker the key, rather than forwarding the real one. */
  readonly requireCredentialBrokering?: boolean
}

export type FxVertex = { readonly project: string; readonly location: string }

/** fx's configured provider for Vertex AI. */
export const FX_VERTEX_PROVIDER = 'vertex'

/** Vertex AI's API host for a region: `global` has no prefix. */
const vertexHost = (location: string) =>
  location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`

/** Where fx sends Vertex AI's calls: the relay's copy of `…/endpoints/openapi`, which fx appends `/chat/completions` to. */
export const fxVertexBaseUrl = ({ project, location }: FxVertex) =>
  `${relayUrl}/v1/projects/${project}/locations/${location}/endpoints/openapi`

type FxRoute = Pick<FxHarnessSettings, 'vertex' | 'effort'>

/**
 * fx's process env: quiet flags, the provider, the model and the relay. The same keys for every
 * model, so the bootstrap an image bakes for one provider serves the others.
 */
export function fxEnv(model: string, { vertex, effort }: FxRoute = {}) {
  const provider = vertex ? FX_VERTEX_PROVIDER : fxProviderOf(model)
  return {
    ...FX_QUIET_ENV,
    FX_PROVIDER: provider,
    FX_MODEL: model,
    FX_GATEWAY_BASE_URL: relayUrl,
    // The model calls' own URL: unset, fx sends them to AI Gateway directly, past the relay.
    FX_GATEWAY_CHAT_URL: `${relayUrl}${FX_GATEWAY_CHAT_PATH}`,
    FX_RELAY_UPSTREAM: vertex
      ? `https://${vertexHost(vertex.location)}`
      : FX_PROVIDERS[fxProviderOf(model)].url,
    FX_RELAY_GOOGLE: vertex ? '1' : '',
    FX_RELAY_EFFORT: effort ?? '',
  }
}

/**
 * fx's `settings.json`: no session titles, which fx otherwise generates on its own model
 * (`openai/gpt-5.6-luna`) with each first prompt, so the run's model is the only one called; and
 * for a bare OpenAI id, OpenAI's Chat Completions API as the configured provider `openai`, or on
 * Vertex AI its Chat Completions endpoint as `vertex`, with no auth of fx's own.
 */
export function fxSettings(model: string, { vertex }: FxRoute = {}) {
  const providers = vertex
    ? {
        [FX_VERTEX_PROVIDER]: {
          protocol: 'openai-chat-completions',
          base_url: fxVertexBaseUrl(vertex),
          auth: { type: 'none' },
        },
      }
    : fxProviderOf(model) === 'openai'
      ? {
          openai: {
            protocol: 'openai-chat-completions',
            base_url: `${relayUrl}/v1`,
            auth: { type: 'bearer', env: FX_PROVIDERS.openai.credential },
          },
        }
      : undefined
  const settings = { session_titles: false, ...(providers && { providers }) }
  return [{ path: '.fx/settings.json', content: `${JSON.stringify(settings, null, 2)}\n` }]
}

/**
 * fx (`fx acp`) as an AI SDK harness, on Vercel AI Gateway or OpenAI's API by the model id, or on
 * Vertex AI. Thin config over `@ai-sdk/harness-acp`: fx names its tool calls, and its ACP
 * `PromptResponse.usage` is the turn's summed tokens, so {@link FxStreamTranslator} only renames
 * MCP calls, rebuilds command output and keeps the reasoning tokens.
 */
export function createFx(settings: FxHarnessSettings): HarnessV1<FxBuiltinTools> {
  const { vertex } = settings
  const provider = vertex ? undefined : FX_PROVIDERS[fxProviderOf(settings.model)]
  if (
    !isHarnessAuthenticationEnvironment(settings.auth) ||
    (provider && !settings.auth[provider.credential])
  ) {
    throw new Error(
      `fx auth must be an environment object with ${provider?.credential ?? 'no key'} for ${settings.model}`,
    )
  }
  const route = {
    ...(vertex ? { vertex } : {}),
    ...(settings.effort ? { effort: settings.effort } : {}),
  }
  const mcpServers = Object.keys(settings.mcpServers ?? {})
  const acp = createACP({
    version: 'v1',
    harnessId: FX_HARNESS_ID,
    builtinTools: FX_BUILTIN_TOOLS,
    source: { type: 'install-command', command: FX_INSTALL_COMMAND },
    executable: 'fx-acp',
    args: [],
    auth: settings.auth,
    env: fxEnv(settings.model, route),
    credentialEnv: Object.values(FX_PROVIDERS).map((each) => each.credential),
    credentialBrokering: ({ env, sandboxEnv, headers }) => {
      if (!provider) return []
      const key = env[provider.credential]
      const placeholder = sandboxEnv?.[provider.credential]
      if (!key || !placeholder) return []
      return [
        createCredentialRequestTransformation({
          matchUrl: provider.url,
          matchHeaders: { Authorization: `Bearer ${placeholder}` },
          transformHeaders: { ...headers, Authorization: `Bearer ${key}` },
        }),
      ]
    },
    ...(settings.mcpServers ? { mcpServers: settings.mcpServers } : {}),
    modelMapping: { type: 'session-config-option', path: 'model' },
    // fx's `auto` mode runs a reviewer model on each action; `full-access` runs none.
    permissionModeMapping: {
      'allow-reads': { type: 'session-mode', modeId: 'ask' },
      'allow-edits': { type: 'session-mode', modeId: 'ask' },
      'allow-all': { type: 'session-mode', modeId: 'full-access' },
    },
    skillsDirectory: FX_HOME_SKILLS_DIR,
    // Not authentication: the hook that writes into fx's private home before it starts.
    authenticationFiles: () => fxSettings(settings.model, route),
  })
  return {
    ...acp,
    doStart: async (options) => {
      const sandbox = options.sandboxSession as { addRequestTransformations?: unknown }
      if (
        provider &&
        settings.requireCredentialBrokering &&
        typeof sandbox.addRequestTransformations !== 'function'
      ) {
        throw new Error(
          `The sandbox can't broker ${provider.credential} (it has no request transformations), and requireCredentialBrokering is set, so the key stays out of it.`,
        )
      }
      return translated(await acp.doStart(options), mcpServers)
    },
  }
}

type Session = Awaited<ReturnType<HarnessV1['doStart']>>
type Emit = (part: { type: string; [key: string]: unknown }) => void

/** The session, with each turn's parts through a fresh {@link FxStreamTranslator}. */
function translated(session: Session, mcpServers: readonly string[]): Session {
  const turn = (run: (options: never) => unknown) => (options: { emit: Emit }) => {
    const translator = new FxStreamTranslator({ mcpServers })
    return run({
      ...options,
      emit: (part: Parameters<Emit>[0]) => options.emit(translator.push(part)),
    } as never)
  }
  return new Proxy(session, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (key !== 'doPromptTurn' && key !== 'doContinueTurn') return value
      return turn(value.bind(target))
    },
  })
}
