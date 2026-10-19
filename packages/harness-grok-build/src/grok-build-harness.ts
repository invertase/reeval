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
export const GROK_CLI_VERSION = '1.0.62'
/** The `dist.integrity` of `@xai-official/grok-linux-<arch>@<version>`, its native build. */
export const GROK_CLI_INTEGRITY = {
  x64: 'sha512-MsqDUf0rryWKchpO7TBFY/npVTKiBF/4zarOXzBOqd0YVpnSs9P0tZmZdXQ0o95s9e4FTvpy/CgUbuOsiqkyVA==',
  arm64:
    'sha512-IyxJjZzL8joNPLw/qx9TN4zoSA0vgXIZbOLptadLrP3lOrUV5TzpYT/EwhM9GhHxQGmovrm9oJFbuB+WYeTujQ==',
} as const
/** The only credential the adapter uses: an xAI API key. */
export const GROK_CREDENTIAL_ENV = 'XAI_API_KEY'
export const XAI_API_URL = 'https://api.x.ai'
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

/**
 * Downloads the pinned native build for the sandbox's arch from npm, checks its sha512, and
 * unpacks its brotli-compressed binary into `~/.local/bin`, as the npm package's postinstall does.
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
grok --version`

export type GrokBuildHarnessSettings = {
  /** `{ XAI_API_KEY }`, the only key used. The host environment is never read. */
  readonly auth: HarnessV1AuthenticationEnvironment
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
export function grokConfig(settings: Pick<GrokBuildHarnessSettings, 'model' | 'effort'>) {
  const lines = [
    '[models]',
    `default = ${JSON.stringify(settings.model)}`,
    `session_summary = ${JSON.stringify(settings.model)}`,
    ...(settings.effort ? [`default_reasoning_effort = ${JSON.stringify(settings.effort)}`] : []),
    '',
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
 * Grok Build (`grok agent stdio`) as an AI SDK harness, on an xAI API key: a model is an xAI id
 * such as `grok-4.6`. Thin config over `@ai-sdk/harness-acp`.
 */
export function createGrokBuild(
  settings: GrokBuildHarnessSettings,
): HarnessV1<GrokBuildBuiltinTools> {
  if (!isHarnessAuthenticationEnvironment(settings.auth) || !settings.auth[GROK_CREDENTIAL_ENV]) {
    throw new Error(
      `Grok Build auth must be an environment object with ${GROK_CREDENTIAL_ENV} (an xAI API key)`,
    )
  }
  const mcpServers = Object.keys(settings.mcpServers ?? {})
  const acp = createACP({
    version: 'v1',
    harnessId: GROK_BUILD_HARNESS_ID,
    builtinTools: GROK_BUILD_BUILTIN_TOOLS,
    source: { type: 'install-command', command: GROK_INSTALL_COMMAND },
    executable: 'grok',
    args: ['agent', 'stdio'],
    auth: settings.auth,
    authentication: { methodId: 'xai.api_key' },
    env: GROK_QUIET_ENV,
    credentialEnv: [GROK_CREDENTIAL_ENV],
    credentialBrokering: ({ env, sandboxEnv, headers }) => {
      const key = env[GROK_CREDENTIAL_ENV]
      const placeholder = sandboxEnv?.[GROK_CREDENTIAL_ENV]
      if (!key || !placeholder) return []
      return [
        createCredentialRequestTransformation({
          matchUrl: XAI_API_URL,
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
          `The sandbox can't broker ${GROK_CREDENTIAL_ENV} (it has no request transformations), and requireCredentialBrokering is set, so the key stays out of it.`,
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
