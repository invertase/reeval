import type { HarnessV1, HarnessV1AuthenticationEnvironment } from '@ai-sdk/harness'
import {
  createCredentialRequestTransformation,
  isHarnessAuthenticationEnvironment,
} from '@ai-sdk/harness/utils'
import { createACP } from '@ai-sdk/harness-acp'
import { GrokBuildStreamTranslator } from './grok-build-stream.ts'
import { GROK_BUILD_BUILTIN_TOOLS, type GrokBuildBuiltinTools } from './grok-build-tools.ts'

export const GROK_BUILD_HARNESS_ID = 'grok-build'
/** The Grok Build release the bootstrap installs, checked against npm's published sha512s. */
export const GROK_CLI_VERSION = '1.0.70'
/** The `dist.integrity` of `@xai-official/grok-linux-<arch>@<version>`, its native build. */
export const GROK_CLI_INTEGRITY = {
  x64: 'sha512-rElshycz/6SgPSkiFGtKHA4vSVOI8qQ6d0jFeu4I92hXCMfvxgMiOvNSzuBhm2P8Jd+4rNGAty2zW0VwmgHSeA==',
  arm64:
    'sha512-rH0TfWOT/Ca/sBMtAJJ+GJ9UyZlr/TkTqIHq8FL7o+ZTzJMBWvCv40JC4T/XuwEZ3WMmxOHGiPap7H9B4SbDSw==',
} as const
/** The credential the adapter uses by default: an xAI API key. */
export const GROK_CREDENTIAL_ENV = 'XAI_API_KEY'
export const XAI_API_URL = 'https://api.x.ai'

/**
 * An OpenAI-compatible endpoint Grok runs the model on through a `[model.<id>]` table in its
 * `config.toml`, keyed from `credentialEnv` (its `env_key`) as a Bearer token.
 */
export type GrokProvider = {
  readonly name: string
  readonly credentialEnv: string
  /** The API base, `base_url`, which Grok adds `/chat/completions` to. */
  readonly baseUrl: string
  /**
   * False when whoever runs the sandbox adds the real credential to the model calls itself (a
   * short-lived access token): the adapter brokers nothing, and Grok sends whatever `auth` holds.
   */
  readonly brokered?: false
}

/** The variable Grok's `env_key` reads on Vertex AI, where the sandbox's gateway adds the token. */
export const VERTEX_TOKEN_ENV = 'VERTEX_ACCESS_TOKEN'

/**
 * Vertex AI's OpenAI-compatible Chat Completions API in a project and region, whose model ids
 * name their publisher (`xai/grok-4.6`). It takes a Google Cloud access token as a Bearer token,
 * which the sandbox's gateway adds, so nothing is brokered.
 */
export function vertexProvider(project: string, region: string): GrokProvider {
  const host =
    region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`
  return {
    name: 'Vertex AI',
    credentialEnv: VERTEX_TOKEN_ENV,
    baseUrl: `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${region}/endpoints/openapi`,
    brokered: false,
  }
}

/** Vercel AI Gateway's Chat Completions API, whose model ids name their provider (`xai/grok-4.6`). */
export const AI_GATEWAY_PROVIDER: GrokProvider = {
  name: 'Vercel AI Gateway',
  credentialEnv: 'AI_GATEWAY_API_KEY',
  baseUrl: 'https://ai-gateway.vercel.sh/v1',
}

/** OpenRouter's Chat Completions API, whose model ids name their provider (`x-ai/grok-4.6`). */
export const OPENROUTER_PROVIDER: GrokProvider = {
  name: 'OpenRouter',
  credentialEnv: 'OPENROUTER_API_KEY',
  baseUrl: 'https://openrouter.ai/api/v1',
}
/**
 * Where harness-placed skills go, under Grok's home. The bootstrap gives Grok a private home,
 * `~/.ai-sdk-harness/.harness-bootstrap/grok-build/implementation/home`, so this is under that.
 */
export const GROK_HOME_SKILLS_DIR = '.grok/skills'
/** The repo skill directory Grok reads (it also reads `.agents/skills` and `.claude/skills`). */
export const GROK_WORKSPACE_SKILLS_DIR = '.grok/skills'

/**
 * The requests Grok sends the key on: the model list and the key's own status, fetched as a
 * session starts, and its model calls, which go to the Chat Completions API (the Responses API
 * for a model the list says takes it, and for the `web_search` tool). A gateway that enforces
 * them refuses the key anywhere else.
 */
export const GROK_ENDPOINTS = [
  { host: 'api.x.ai', path: { exact: '/v1/models' }, method: ['GET'] },
  { host: 'api.x.ai', path: { exact: '/v1/api-key' }, method: ['GET'] },
  { host: 'api.x.ai', path: { exact: '/v1/chat/completions' }, method: ['POST'] },
  { host: 'api.x.ai', path: { exact: '/v1/responses' }, method: ['POST'] },
] as const

/**
 * Grok's process env: the workspace trusted, so it reads the repo's `AGENTS.md` and skills
 * (an untrusted folder's are ignored), and no self-update.
 */
export const GROK_QUIET_ENV = {
  GROK_FOLDER_TRUST: 'false',
  GROK_DISABLE_AUTOUPDATER: '1',
} as const

/** The variable `grok-acp` reads the session's plugin directories from, `:`-separated. */
export const GROK_PLUGIN_DIRS_ENV = 'GROK_HARNESS_PLUGIN_DIRS'

/**
 * `grok-acp`: `grok agent --no-leader [--plugin-dir <dir>]… stdio`, a `--plugin-dir` for each
 * directory in {@link GROK_PLUGIN_DIRS_ENV}. The bootstrap is keyed on the launch arguments, so
 * they stay the same and the directories come in the environment. `--no-leader`, since a leader
 * Grok's config turns on ignores `--plugin-dir`.
 */
const GROK_LAUNCH = `#!/bin/sh
set -f
set -- agent --no-leader
IFS=:
for dir in \${${GROK_PLUGIN_DIRS_ENV}:-}; do set -- "$@" --plugin-dir "$dir"; done
exec "$(dirname "$0")/grok" "$@" stdio
`

/**
 * Downloads the pinned native build for the sandbox's arch from npm, checks its sha512, and
 * unpacks its brotli-compressed binary into `~/.local/bin`, as the npm package's postinstall does;
 * then writes `grok-acp` beside it.
 */
export const GROK_INSTALL_COMMAND = `set -eu
case "$(uname -m)" in
  x86_64|amd64) arch=x64 sri=${GROK_CLI_INTEGRITY.x64} ;;
  aarch64|arm64) arch=arm64 sri=${GROK_CLI_INTEGRITY.arm64} ;;
  *) echo "Grok Build has no Linux build for $(uname -m)" >&2; exit 1 ;;
esac
curl -fsSL --retry 3 -o grok.tgz "https://registry.npmjs.org/@xai-official/grok-linux-$arch/-/grok-linux-$arch-${GROK_CLI_VERSION}.tgz"
node -e 'const h = "sha512-" + require("crypto").createHash("sha512").update(require("fs").readFileSync("grok.tgz")).digest("base64"); if (h !== process.argv[1]) { console.error("grok.tgz does not match its sha512"); process.exit(1) }' "$sri"
rm -rf package && tar -xzf grok.tgz package/bin/grok.br && rm grok.tgz
node -e 'const fs = require("fs"); fs.writeFileSync(process.argv[1], require("zlib").brotliDecompressSync(fs.readFileSync("package/bin/grok.br")), { mode: 0o755 })' "$HOME/.local/bin/grok"
rm -rf package
cat > "$HOME/.local/bin/grok-acp" <<'GROK_LAUNCH'
${GROK_LAUNCH}GROK_LAUNCH
chmod +x "$HOME/.local/bin/grok-acp"
grok --version`

export type GrokBuildHarnessSettings = {
  /**
   * The key under its variable, `{ XAI_API_KEY }` by default (the provider's `credentialEnv` with
   * one), the only key used. The host environment is never read.
   */
  readonly auth: HarnessV1AuthenticationEnvironment
  /** Another endpoint for the model calls; xAI's API by default. */
  readonly provider?: GrokProvider
  /**
   * The model a session starts on, and the one Grok names sessions with (`[models] default` and
   * `session_summary` in its `config.toml`), so every call is on the run's model.
   */
  readonly model: string
  /**
   * MCP servers in ACP's `McpServer` shape, keyed by name, which Grok takes on `session/new`:
   * stdio `{ command, args, env }`, or `{ type: 'http' | 'sse', url, headers }`, with `env` and
   * `headers` as `{ name, value }` lists.
   */
  readonly mcpServers?: Record<string, Record<string, unknown>>
  /**
   * Plugin directories in the sandbox (absolute), in Claude Code's plugin layout, each loaded with
   * `--plugin-dir` for every session: trusted, so their hooks and MCP servers start unprompted.
   */
  readonly pluginDirs?: readonly string[]
  /**
   * The names of the MCP servers those plugins declare, as Grok knows them (the plugin's own key,
   * `stamp`), so a `use_tool` call of one is named `mcp__stamp__<tool>` like a server's above.
   */
  readonly pluginMcpServers?: readonly string[]
  /** Refuse a sandbox that can't broker the key, rather than forwarding the real one. */
  readonly requireCredentialBrokering?: boolean
  /**
   * Reasoning effort for a model that takes one (`low`, `medium`, `high`, …), as
   * `[models] default_reasoning_effort`. It's in a file rather than `--reasoning-effort`, so the
   * bootstrap, keyed on the arguments, is the same for every effort.
   */
  readonly effort?: string
}

/**
 * Grok's `config.toml`, in its private home: the run's model for the session and its title, the
 * effort when set, and no telemetry, feedback, remote config or campaigns, and no summary, recap
 * or title refresh calls after a turn.
 */
export function grokConfig(
  settings: Pick<GrokBuildHarnessSettings, 'model' | 'effort' | 'provider'>,
) {
  const model = JSON.stringify(settings.model)
  const lines = [
    '[models]',
    `default = ${model}`,
    `session_summary = ${model}`,
    ...(settings.effort ? [`default_reasoning_effort = ${JSON.stringify(settings.effort)}`] : []),
    '',
    ...(settings.provider
      ? [
          `[model.${model}]`,
          `model = ${model}`,
          `base_url = ${JSON.stringify(settings.provider.baseUrl)}`,
          `env_key = ${JSON.stringify(settings.provider.credentialEnv)}`,
          'api_backend = "chat_completions"',
          // A model of reeval's own table offers no effort until it lists one.
          ...(settings.effort
            ? [`reasoning_efforts = [{ value = ${JSON.stringify(settings.effort)} }]`]
            : []),
          '',
        ]
      : []),
    '[features]',
    'telemetry = false',
    'feedback = false',
    'managed_config = false',
    'campaigns = false',
    'title_refresh = false',
    'turn_summary = false',
    'session_recap = false',
    '',
    '[cli]',
    'auto_update = false',
  ]
  return { path: '.grok/config.toml', content: `${lines.join('\n')}\n` }
}

/**
 * Grok Build (`grok agent stdio`) as an AI SDK harness, on an xAI API key (a model is an xAI id
 * such as `grok-4.6`) or another {@link GrokProvider}. Thin config over `@ai-sdk/harness-acp`.
 */
export function createGrokBuild(
  settings: GrokBuildHarnessSettings,
): HarnessV1<GrokBuildBuiltinTools> {
  const credential = settings.provider?.credentialEnv ?? GROK_CREDENTIAL_ENV
  const name = settings.provider?.name
  const keyFor = name ? `${/^[AEIOU]/.test(name) ? 'an' : 'a'} ${name} key` : 'an xAI API key'
  if (!isHarnessAuthenticationEnvironment(settings.auth) || !settings.auth[credential]) {
    throw new Error(`Grok Build auth must be an environment object with ${credential} (${keyFor})`)
  }
  const apiUrl = settings.provider ? new URL(settings.provider.baseUrl).origin : XAI_API_URL
  const mcpServers = [
    ...Object.keys(settings.mcpServers ?? {}),
    ...(settings.pluginMcpServers ?? []),
  ]
  const acp = createACP({
    version: 'v1',
    harnessId: GROK_BUILD_HARNESS_ID,
    builtinTools: GROK_BUILD_BUILTIN_TOOLS,
    source: { type: 'install-command', command: GROK_INSTALL_COMMAND },
    executable: 'grok-acp',
    args: [],
    auth: settings.auth,
    authentication: { methodId: 'xai.api_key' },
    env: { ...GROK_QUIET_ENV, [GROK_PLUGIN_DIRS_ENV]: (settings.pluginDirs ?? []).join(':') },
    // Every provider's, not just this one's: the bootstrap is keyed on these names, so the image's
    // bootstrap serves each provider.
    credentialEnv: [
      GROK_CREDENTIAL_ENV,
      AI_GATEWAY_PROVIDER.credentialEnv,
      OPENROUTER_PROVIDER.credentialEnv,
      VERTEX_TOKEN_ENV,
    ],
    credentialBrokering: ({ env, sandboxEnv, headers }) => {
      const key = env[credential]
      const placeholder = sandboxEnv?.[credential]
      if (!key || !placeholder || settings.provider?.brokered === false) return []
      return [
        createCredentialRequestTransformation({
          matchUrl: apiUrl,
          matchHeaders: { Authorization: `Bearer ${placeholder}` },
          transformHeaders: { ...headers, Authorization: `Bearer ${key}` },
        }),
      ]
    },
    modelMapping: { type: 'session-model', path: 'modelId' },
    skillsDirectory: GROK_HOME_SKILLS_DIR,
    ...(settings.mcpServers ? { mcpServers: settings.mcpServers } : {}),
    // Not authentication: the hook that writes into Grok's private home before it starts.
    authenticationFiles: () => [grokConfig(settings)],
  })
  return {
    ...acp,
    doStart: async (options) => {
      const sandbox = options.sandboxSession as { addRequestTransformations?: unknown }
      if (
        settings.requireCredentialBrokering &&
        typeof sandbox.addRequestTransformations !== 'function'
      ) {
        throw new Error(
          `The sandbox can't broker ${credential} (it has no request transformations), and requireCredentialBrokering is set, so the key stays out of it.`,
        )
      }
      return translated(await acp.doStart(options), mcpServers)
    },
  }
}

type Session = Awaited<ReturnType<HarnessV1['doStart']>>
type Emit = (part: { type: string; [key: string]: unknown }) => void

/** The session, with each turn's parts through a fresh {@link GrokBuildStreamTranslator}. */
function translated(session: Session, mcpServers: readonly string[]): Session {
  const turn = (run: (options: never) => unknown) => (options: { emit: Emit }) => {
    const translator = new GrokBuildStreamTranslator({ mcpServers })
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
