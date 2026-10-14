import type { HarnessV1, HarnessV1AuthenticationEnvironment } from '@ai-sdk/harness'
import {
  createCredentialRequestTransformation,
  isHarnessAuthenticationEnvironment,
} from '@ai-sdk/harness/utils'
import { createACP } from '@ai-sdk/harness-acp'
import { GooseStreamTranslator } from './goose-stream.ts'
import { GOOSE_BUILTIN_TOOLS, type GooseBuiltinTools } from './goose-tools.ts'

export const GOOSE_HARNESS_ID = 'goose'
/** The Goose release the bootstrap installs, checked against its published sha256s. */
export const GOOSE_CLI_VERSION = '1.54.0'
export const GOOSE_CLI_SHA256 = {
  x86_64: 'ab396c95aebbd28b4d38c175234be8d4a3ea0c96e7ccb24c307e4618c9be57e1',
  aarch64: '0f174b5118a53888cd4e65b7ca9a4b72dd0b887e89142c8ce41e2409205e40d5',
} as const
/** The only credential the adapter uses: a Gemini API key, for Goose's `google` provider. */
export const GOOSE_CREDENTIAL_ENV = 'GOOGLE_API_KEY'
export const GEMINI_API_URL = 'https://generativelanguage.googleapis.com'
/** The header Goose's `google` provider sends the key in. */
export const GEMINI_API_KEY_HEADER = 'x-goog-api-key'
/**
 * Where harness-placed skills go, under Goose's home. The bootstrap gives Goose a private home,
 * `~/.ai-sdk-harness/.harness-bootstrap/goose/implementation/home`, so this is under that.
 */
export const GOOSE_HOME_SKILLS_DIR = '.config/goose/skills'
/** The repo skill directory Goose reads (it also reads `.agents/skills` and `.claude/skills`). */
export const GOOSE_WORKSPACE_SKILLS_DIR = '.goose/skills'

/**
 * The Google provider on a Gemini API key, headless, with nothing sent but model requests: no
 * telemetry, no keyring, and no extra model call to name the session.
 */
export const GOOSE_QUIET_ENV = {
  GOOSE_PROVIDER: 'google',
  GOOSE_MODE: 'auto',
  GOOSE_TELEMETRY_OFF: '1',
  GOOSE_DISABLE_KEYRING: '1',
  GOOSE_DISABLE_SESSION_NAMING: '1',
} as const

/**
 * The endpoints Goose sends the key on: the model request, `POST
 * /v1beta/models/<model>:streamGenerateContent`, and the model list, `GET /v1beta/models`, which
 * it fetches at the start of every turn. A gateway that enforces them refuses the key anywhere
 * else.
 */
export const GOOSE_ENDPOINTS = [
  {
    host: new URL(GEMINI_API_URL).hostname,
    path: { regex: '^/v1beta/models/[^/]+:streamGenerateContent$' },
    method: ['POST'],
  },
  // The model list, fetched with the key at the start of every turn.
  { host: new URL(GEMINI_API_URL).hostname, path: { regex: '^/v1beta/models$' }, method: ['GET'] },
] as const

/** Downloads the pinned release for the sandbox's arch and checks its sha256. */
export const GOOSE_INSTALL_COMMAND = `case "$(uname -m)" in
  x86_64|amd64) arch=x86_64 sha=${GOOSE_CLI_SHA256.x86_64} ;;
  aarch64|arm64) arch=aarch64 sha=${GOOSE_CLI_SHA256.aarch64} ;;
  *) echo "Goose has no release for $(uname -m)" >&2; exit 1 ;;
esac
curl -fsSL --retry 3 -o goose.tar.gz "https://github.com/aaif-goose/goose/releases/download/v${GOOSE_CLI_VERSION}/goose-$arch-unknown-linux-gnu.tar.gz"
echo "$sha  goose.tar.gz" | sha256sum -c -
tar -xzf goose.tar.gz -C "$HOME/.local/bin" ./goose
rm goose.tar.gz`

export type GooseHarnessSettings = {
  /** `{ GOOGLE_API_KEY }`, the only key used. The host environment is never read. */
  readonly auth: HarnessV1AuthenticationEnvironment
  /**
   * The Gemini model a session starts on (`GOOSE_MODEL`): Goose refuses `session/new` without
   * one, before any turn sets its model. The bootstrap is keyed on the variables' names, so an
   * image baked with any model serves every model.
   */
  readonly model: string
  /**
   * MCP servers as Goose extensions, keyed by name: `{ type: 'stdio', cmd, args, envs }` or
   * `{ type: 'streamable_http', uri, headers }`. They go in Goose's `config.yaml`, enabled:
   * Goose leaves servers from ACP `session/new` disabled until the model enables them itself.
   */
  readonly mcpServers?: Record<string, Record<string, unknown>>
  /** Refuse a sandbox that can't broker the key, rather than forwarding the real one. */
  readonly requireCredentialBrokering?: boolean
  /**
   * Reasoning effort as `GOOSE_THINKING_EFFORT` (`off`, `low`, `medium`, `high`, `max`, …).
   */
  readonly effort?: string
}

/** Goose's process env: quiet flags, the model, and thinking effort when set. */
export function gooseEnv(settings: Pick<GooseHarnessSettings, 'model' | 'effort'>) {
  return {
    ...GOOSE_QUIET_ENV,
    GOOSE_MODEL: settings.model,
    ...(settings.effort ? { GOOSE_THINKING_EFFORT: settings.effort } : {}),
  }
}

/**
 * Goose (`goose acp`) as an AI SDK harness, on its `google` provider with a Gemini API key: a
 * model is a Gemini id such as `gemini-3.8-flash`. Thin config over `@ai-sdk/harness-acp`.
 *
 * Goose's ACP `PromptResponse.usage` is its last model call's, not the turn's, so turns report no
 * usage here rather than an undercount (see {@link GooseStreamTranslator}).
 */
export function createGoose(settings: GooseHarnessSettings): HarnessV1<GooseBuiltinTools> {
  if (!isHarnessAuthenticationEnvironment(settings.auth) || !settings.auth[GOOSE_CREDENTIAL_ENV]) {
    throw new Error(
      `Goose auth must be an environment object with ${GOOSE_CREDENTIAL_ENV} (a Gemini API key)`,
    )
  }
  const mcpServers = Object.keys(settings.mcpServers ?? {})
  const acp = createACP({
    version: 'v1',
    harnessId: GOOSE_HARNESS_ID,
    builtinTools: GOOSE_BUILTIN_TOOLS,
    source: { type: 'install-command', command: GOOSE_INSTALL_COMMAND },
    executable: 'goose',
    args: ['acp'],
    auth: settings.auth,
    env: gooseEnv(settings),
    credentialEnv: [GOOSE_CREDENTIAL_ENV],
    credentialBrokering: ({ env, sandboxEnv, headers }) => {
      const key = env[GOOSE_CREDENTIAL_ENV]
      const placeholder = sandboxEnv?.[GOOSE_CREDENTIAL_ENV]
      if (!key || !placeholder) return []
      return [
        createCredentialRequestTransformation({
          matchUrl: GEMINI_API_URL,
          matchHeaders: { [GEMINI_API_KEY_HEADER]: placeholder },
          transformHeaders: { ...headers, [GEMINI_API_KEY_HEADER]: key },
        }),
      ]
    },
    modelMapping: { type: 'session-config-option', path: 'model' },
    skillsDirectory: GOOSE_HOME_SKILLS_DIR,
    // Not authentication: the hook that writes into Goose's private home before it starts.
    authenticationFiles: () => (mcpServers.length ? [gooseConfig(settings.mcpServers ?? {})] : []),
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
          `The sandbox can't broker ${GOOSE_CREDENTIAL_ENV} (it has no request transformations), and requireCredentialBrokering is set, so the key stays out of it.`,
        )
      }
      return translated(await acp.doStart(options), mcpServers)
    },
  }
}

/** Goose's `config.yaml` (as JSON, which YAML reads) with each MCP server an enabled extension. */
export function gooseConfig(servers: Record<string, Record<string, unknown>>) {
  const extensions = Object.fromEntries(
    Object.entries(servers).map(([name, s]) => [name, { name, enabled: true, timeout: 300, ...s }]),
  )
  return {
    path: '.config/goose/config.yaml',
    content: `${JSON.stringify({ extensions }, null, 2)}\n`,
  }
}

type Session = Awaited<ReturnType<HarnessV1['doStart']>>
type Emit = (part: { type: string; [key: string]: unknown }) => void

/** The session, with each turn's parts through a fresh {@link GooseStreamTranslator}. */
function translated(session: Session, mcpServers: readonly string[]): Session {
  const turn = (run: (options: never) => unknown) => (options: { emit: Emit }) => {
    const translator = new GooseStreamTranslator({ mcpServers })
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
