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
 * provider, or OpenAI's Chat Completions API for a bare OpenAI id (`gpt-4.1`), as an fx
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

/** Downloads the pinned release for the sandbox's arch and checks its sha256. */
export const FX_INSTALL_COMMAND = `case "$(uname -m)" in
  x86_64|amd64) arch=x86_64 sha=${FX_CLI_SHA256.x86_64} ;;
  aarch64|arm64) arch=aarch64 sha=${FX_CLI_SHA256.aarch64} ;;
  *) echo "fx has no release for $(uname -m)" >&2; exit 1 ;;
esac
curl -fsSL --retry 3 -o fx.tar.gz "https://github.com/vercel-labs/fx/releases/download/v${FX_CLI_VERSION}/fx-linux-$arch.tar.gz"
echo "$sha  fx.tar.gz" | sha256sum -c -
mkdir -p "$HOME/.local/bin"
tar -xzf fx.tar.gz -C "$HOME/.local/bin" fx
rm fx.tar.gz`

export type FxHarnessSettings = {
  /** The model's provider's key only (see {@link FX_PROVIDERS}). The host environment is never read. */
  readonly auth: HarnessV1AuthenticationEnvironment
  /** A gateway id (`anthropic/claude-sonnet-5`) or a bare OpenAI id (`gpt-4.1`). */
  readonly model: string
  /** MCP servers in ACP's `McpServer` shape, keyed by name, passed on `session/new`. */
  readonly mcpServers?: Record<string, Record<string, unknown>>
  /** Refuse a sandbox that can't broker the key, rather than forwarding the real one. */
  readonly requireCredentialBrokering?: boolean
}

/** fx's process env: quiet flags, the provider and the model. */
export function fxEnv(model: string) {
  return { ...FX_QUIET_ENV, FX_PROVIDER: fxProviderOf(model), FX_MODEL: model }
}

/**
 * fx's `settings.json`, with OpenAI's Chat Completions API as the configured provider `openai`
 * for a bare OpenAI id; the gateway needs none.
 */
export function fxSettings(model: string) {
  if (fxProviderOf(model) !== 'openai') return []
  const settings = {
    providers: {
      openai: {
        protocol: 'openai-chat-completions',
        base_url: `${FX_PROVIDERS.openai.url}/v1`,
        auth: { type: 'bearer', env: FX_PROVIDERS.openai.credential },
      },
    },
  }
  return [{ path: '.fx/settings.json', content: `${JSON.stringify(settings, null, 2)}\n` }]
}

/**
 * fx (`fx acp`) as an AI SDK harness, on Vercel AI Gateway or OpenAI's API by the model id. Thin
 * config over `@ai-sdk/harness-acp`: fx names its tool calls, and its ACP `PromptResponse.usage`
 * is the turn's summed tokens, so only MCP calls need renaming ({@link FxStreamTranslator}).
 */
export function createFx(settings: FxHarnessSettings): HarnessV1<FxBuiltinTools> {
  const provider = FX_PROVIDERS[fxProviderOf(settings.model)]
  if (!isHarnessAuthenticationEnvironment(settings.auth) || !settings.auth[provider.credential]) {
    throw new Error(
      `fx auth must be an environment object with ${provider.credential} for ${settings.model}`,
    )
  }
  const mcpServers = Object.keys(settings.mcpServers ?? {})
  const acp = createACP({
    version: 'v1',
    harnessId: FX_HARNESS_ID,
    builtinTools: FX_BUILTIN_TOOLS,
    source: { type: 'install-command', command: FX_INSTALL_COMMAND },
    executable: 'fx',
    args: ['acp'],
    auth: settings.auth,
    env: fxEnv(settings.model),
    credentialEnv: [provider.credential],
    credentialBrokering: ({ env, sandboxEnv, headers }) => {
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
    authenticationFiles: () => fxSettings(settings.model),
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
  if (!mcpServers.length) return session
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
