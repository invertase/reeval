import type { HarnessV1, HarnessV1AuthenticationEnvironment } from '@ai-sdk/harness'
import {
  createCredentialRequestTransformation,
  isHarnessAuthenticationEnvironment,
  resolveSandboxHomeDir,
  shellQuote,
} from '@ai-sdk/harness/utils'
import { createACP } from '@ai-sdk/harness-acp'
import type { Experimental_SandboxSession } from '@ai-sdk/provider-utils'
import {
  GOOSE_LAUNCHER,
  GOOSE_LAUNCHER_ENV,
  GOOSE_LAUNCHER_EXECUTABLE,
  GOOSE_LAUNCHER_PATH,
} from './goose-launcher.ts'
import { GooseStreamTranslator } from './goose-stream.ts'
import { GOOSE_BUILTIN_TOOLS, type GooseBuiltinTools } from './goose-tools.ts'

export const GOOSE_HARNESS_ID = 'goose'
/** The Goose release the bootstrap installs, checked against its published sha256s. */
export const GOOSE_CLI_VERSION = '1.56.0'
export const GOOSE_CLI_SHA256 = {
  x86_64: '225a929b35b5130fb691eafdb50be236f2c0a150019b53973775938f8f19c281',
  aarch64: '26bcb7d3f55aac485a91d81cbdecd8d90e5af1acadeca6e580b4d58b64a888e4',
} as const
/** The credential the adapter uses by default: a Gemini API key, for Goose's `google` provider. */
export const GOOSE_CREDENTIAL_ENV = 'GOOGLE_API_KEY'
export const GEMINI_API_URL = 'https://generativelanguage.googleapis.com'
/** The header Goose's `google` provider sends the key in. */
export const GEMINI_API_KEY_HEADER = 'x-goog-api-key'

/** A Goose provider (`GOOSE_PROVIDER`): the variable its key is in, and how it sends it where. */
export type GooseProvider = {
  readonly name: string
  readonly id: string
  readonly credentialEnv: string
  readonly baseUrl: string
  readonly header: string
  /** Set when the header's value is `<scheme> <key>`, not the bare key. */
  readonly scheme?: string
}

/** Google's Gemini API with a Gemini API key: the default. */
export const GEMINI_PROVIDER: GooseProvider = {
  name: 'Gemini API',
  id: 'google',
  credentialEnv: GOOSE_CREDENTIAL_ENV,
  baseUrl: GEMINI_API_URL,
  header: GEMINI_API_KEY_HEADER,
}

/**
 * Goose's built-in Vercel AI Gateway provider, an OpenAI-compatible one whose model ids name
 * their provider (`google/gemini-3-flash`).
 */
export const AI_GATEWAY_PROVIDER: GooseProvider = {
  name: 'Vercel AI Gateway',
  id: 'vercel_ai_gateway',
  credentialEnv: 'AI_GATEWAY_API_KEY',
  baseUrl: 'https://ai-gateway.vercel.sh',
  header: 'Authorization',
  scheme: 'Bearer',
}

/**
 * Goose's built-in OpenRouter provider, an OpenAI-compatible one on `https://openrouter.ai`
 * whose model ids name their provider (`google/gemini-3-flash`).
 */
export const OPENROUTER_PROVIDER: GooseProvider = {
  name: 'OpenRouter',
  id: 'openrouter',
  credentialEnv: 'OPENROUTER_API_KEY',
  baseUrl: 'https://openrouter.ai',
  header: 'Authorization',
  scheme: 'Bearer',
}
/**
 * Where harness-placed skills go, under Goose's home. The bootstrap gives Goose a private home,
 * `~/.ai-sdk-harness/.harness-bootstrap/goose/home`, so this is under that.
 */
export const GOOSE_HOME_SKILLS_DIR = '.config/goose/skills'
/** The repo skill directory Goose reads (it also reads `.agents/skills` and `.claude/skills`). */
export const GOOSE_WORKSPACE_SKILLS_DIR = '.goose/skills'

/**
 * Headless, with nothing sent but model requests: no telemetry, no keyring, and no extra model
 * call to name the session.
 */
export const GOOSE_QUIET_ENV = {
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
  /**
   * The provider's key under its `credentialEnv` (`{ GOOGLE_API_KEY }` by default), the only key
   * used. The host environment is never read.
   */
  readonly auth: HarnessV1AuthenticationEnvironment
  /** The provider Goose calls; Google's Gemini API ({@link GEMINI_PROVIDER}) by default. */
  readonly provider?: GooseProvider
  /**
   * The model a session starts on (`GOOSE_MODEL`), in the provider's ids: Goose refuses
   * `session/new` without one, before any turn sets its model. The bootstrap is keyed on the
   * variables' names, so an image baked with any model serves every model.
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
  /**
   * Vertex AI instead of `provider`: Goose's `gcp_vertex_ai` provider on this project and
   * region, reading the service-account file at `credentialsFile` in the sandbox. No key is read
   * (`auth` may be empty); whoever runs the sandbox supplies the file and the token the calls
   * carry.
   */
  readonly vertex?: GooseVertex
}

export type GooseVertex = {
  readonly project: string
  readonly location: string
  readonly credentialsFile: string
}

/** Goose's provider for Vertex AI, which authenticates from Application Default Credentials. */
export const GOOSE_VERTEX_PROVIDER_ID = 'gcp_vertex_ai'

/** Goose's process env: quiet flags, the provider and model, and thinking effort. */
export function gooseEnv(
  settings: Pick<GooseHarnessSettings, 'model' | 'effort' | 'provider' | 'vertex'>,
) {
  const { vertex } = settings
  return {
    ...GOOSE_QUIET_ENV,
    GOOSE_PROVIDER: vertex ? GOOSE_VERTEX_PROVIDER_ID : (settings.provider ?? GEMINI_PROVIDER).id,
    GOOSE_MODEL: settings.model,
    // Set, if empty, at every effort: the bootstrap is keyed on these names, so the image's
    // bootstrap serves every effort. Goose reads an empty value as no effort.
    GOOSE_THINKING_EFFORT: settings.effort ?? '',
    // The launcher sets these in Goose's environment, so the image's bootstrap serves Vertex AI
    // too, and no other provider replaces the eval's own values with empty ones.
    [GOOSE_LAUNCHER_ENV]: JSON.stringify(
      vertex
        ? {
            GCP_PROJECT_ID: vertex.project,
            GCP_LOCATION: vertex.location,
            GOOGLE_APPLICATION_CREDENTIALS: vertex.credentialsFile,
          }
        : {},
    ),
  }
}

/**
 * Goose (`goose acp`) as an AI SDK harness, on its `google` provider with a Gemini API key (a
 * model is a Gemini id such as `gemini-3.8-flash`) or another {@link GooseProvider}. Thin config
 * over `@ai-sdk/harness-acp`.
 *
 * Goose's ACP `PromptResponse.usage` is its last model call's, not the turn's, so turns report no
 * usage here rather than an undercount (see {@link GooseStreamTranslator}).
 */
export function createGoose(settings: GooseHarnessSettings): HarnessV1<GooseBuiltinTools> {
  const provider = settings.provider ?? GEMINI_PROVIDER
  const credential = provider.credentialEnv
  if (
    !isHarnessAuthenticationEnvironment(settings.auth) ||
    (!settings.vertex && !settings.auth[credential])
  ) {
    throw new Error(
      `Goose auth must be an environment object with ${credential} (${/^[AEIOU]/.test(provider.name) ? 'an' : 'a'} ${provider.name} key)`,
    )
  }
  const value = (key: string) => (provider.scheme ? `${provider.scheme} ${key}` : key)
  const mcpServers = Object.keys(settings.mcpServers ?? {})
  const acp = createACP({
    version: 'v1',
    harnessId: GOOSE_HARNESS_ID,
    builtinTools: GOOSE_BUILTIN_TOOLS,
    source: { type: 'install-command', command: GOOSE_INSTALL_COMMAND },
    // The launcher, which runs `goose acp` (see GOOSE_LAUNCHER).
    executable: GOOSE_LAUNCHER_EXECUTABLE,
    args: ['acp'],
    auth: settings.auth,
    env: gooseEnv(settings),
    // Every provider's, not just this one's: the bootstrap is keyed on these names, so the image's
    // bootstrap serves each provider.
    credentialEnv: [
      GEMINI_PROVIDER.credentialEnv,
      AI_GATEWAY_PROVIDER.credentialEnv,
      OPENROUTER_PROVIDER.credentialEnv,
    ],
    credentialBrokering: ({ env, sandboxEnv, headers }) => {
      const key = env[credential]
      const placeholder = sandboxEnv?.[credential]
      if (settings.vertex || !key || !placeholder) return []
      return [
        createCredentialRequestTransformation({
          matchUrl: provider.baseUrl,
          matchHeaders: { [provider.header]: value(placeholder) },
          transformHeaders: { ...headers, [provider.header]: value(key) },
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
        !settings.vertex &&
        settings.requireCredentialBrokering &&
        typeof sandbox.addRequestTransformations !== 'function'
      ) {
        throw new Error(
          `The sandbox can't broker ${credential} (it has no request transformations), and requireCredentialBrokering is set, so the key stays out of it.`,
        )
      }
      const session = await acp.doStart(options)
      // After the bootstrap, which installs Goose's bin directory; the first turn runs it.
      await writeLauncher(options.sandboxSession, options.abortSignal)
      return translated(session, mcpServers)
    },
  }
}

/** Writes the launcher where `harness-acp` runs its executable from, executable. */
async function writeLauncher(sandbox: Experimental_SandboxSession, abortSignal?: AbortSignal) {
  const home = await resolveSandboxHomeDir({ sandbox, ...(abortSignal ? { abortSignal } : {}) })
  const path = `${home}/${GOOSE_LAUNCHER_PATH}`
  await sandbox.run({
    command: `mkdir -p ${shellQuote(path.slice(0, path.lastIndexOf('/')))}`,
    abortSignal,
  })
  await sandbox.writeTextFile({ path, content: GOOSE_LAUNCHER, abortSignal })
  const chmod = await sandbox.run({ command: `chmod 755 ${shellQuote(path)}`, abortSignal })
  if (chmod.exitCode !== 0) throw new Error(`Goose's launcher isn't executable: ${path}`)
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
