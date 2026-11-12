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
  GOOSE_HOME,
  GOOSE_LAUNCHER,
  GOOSE_LAUNCHER_ENV,
  GOOSE_LAUNCHER_EXECUTABLE,
  GOOSE_LAUNCHER_PATH,
} from './goose-launcher.ts'
import { GooseStreamTranslator } from './goose-stream.ts'
import { GOOSE_BUILTIN_TOOLS, type GooseBuiltinTools } from './goose-tools.ts'
import { GooseLedger } from './goose-usage.ts'

export const GOOSE_HARNESS_ID = 'goose'
/** The Goose release the bootstrap installs, checked against its published sha256s. */
export const GOOSE_CLI_VERSION = '1.59.0'
/** Linux's build for each arch, and macOS's for Apple Silicon (a Tart VM). */
export const GOOSE_CLI_SHA256 = {
  x86_64: 'a774667de6c20206a60d78d7bece2d9dda8389667e4f5c2fc8aaa758d1e81ef3',
  aarch64: 'ba96b78394e3050077482bb285ff35f34613646e90b84a18b5d674b71905166e',
  'darwin-aarch64': '0142839f339e3484b49326d69de9d9cf808999087ab421ae9304d2620e647cbc',
} as const
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

/** Goose's `google` provider: Google's Gemini API, with a Gemini API key. */
export const GEMINI_PROVIDER: GooseProvider = {
  name: 'Gemini API',
  id: 'google',
  credentialEnv: 'GOOGLE_API_KEY',
  baseUrl: GEMINI_API_URL,
  header: GEMINI_API_KEY_HEADER,
}

/** Goose's `anthropic` provider: Anthropic's API, with the key in `x-api-key`. */
export const ANTHROPIC_PROVIDER: GooseProvider = {
  name: 'Anthropic API',
  id: 'anthropic',
  credentialEnv: 'ANTHROPIC_API_KEY',
  baseUrl: 'https://api.anthropic.com',
  header: 'x-api-key',
}

/** Goose's `openai` provider: OpenAI's API, with the key as a Bearer token. */
export const OPENAI_PROVIDER: GooseProvider = {
  name: 'OpenAI API',
  id: 'openai',
  credentialEnv: 'OPENAI_API_KEY',
  baseUrl: 'https://api.openai.com',
  header: 'Authorization',
  scheme: 'Bearer',
}

/** Goose's `xai` provider: xAI's API, an OpenAI-compatible one, with the key as a Bearer token. */
export const XAI_PROVIDER: GooseProvider = {
  name: 'xAI API',
  id: 'xai',
  credentialEnv: 'XAI_API_KEY',
  baseUrl: 'https://api.x.ai',
  header: 'Authorization',
  scheme: 'Bearer',
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
 * The endpoints Goose's `google` provider sends the key on: the model request, `POST
 * /v1beta/models/<model>:streamGenerateContent`, and the model list, `GET /v1beta/models`, which
 * it fetches at the start of every turn. A gateway that enforces them refuses the key anywhere
 * else.
 */
export const GOOSE_GEMINI_ENDPOINTS = [
  {
    host: new URL(GEMINI_API_URL).hostname,
    path: { regex: '^/v1beta/models/[^/]+:streamGenerateContent$' },
    method: ['POST'],
  },
  // The model list, fetched with the key at the start of every turn.
  { host: new URL(GEMINI_API_URL).hostname, path: { regex: '^/v1beta/models$' }, method: ['GET'] },
] as const

/** Downloads the pinned release for the sandbox's OS and arch and checks its sha256. */
export const GOOSE_INSTALL_COMMAND = `case "$(uname -s) $(uname -m)" in
  "Linux x86_64"|"Linux amd64") triple=x86_64-unknown-linux-gnu sha=${GOOSE_CLI_SHA256.x86_64} ;;
  "Linux aarch64"|"Linux arm64") triple=aarch64-unknown-linux-gnu sha=${GOOSE_CLI_SHA256.aarch64} ;;
  "Darwin arm64") triple=aarch64-apple-darwin sha=${GOOSE_CLI_SHA256['darwin-aarch64']} ;;
  "Darwin "*) echo "reeval runs Goose on macOS on Apple Silicon only, not $(uname -m)" >&2; exit 1 ;;
  *) echo "Goose has no release for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac
curl -fsSL --retry 3 -o goose.tar.gz "https://github.com/aaif-goose/goose/releases/download/v${GOOSE_CLI_VERSION}/goose-$triple.tar.gz"
node -e 'const h = require("crypto").createHash("sha256").update(require("fs").readFileSync("goose.tar.gz")).digest("hex"); if (h !== process.argv[1]) { console.error("goose.tar.gz does not match its sha256"); process.exit(1) }' "$sha"
tar -xzf goose.tar.gz -C "$HOME/.local/bin" ./goose
rm goose.tar.gz`

export type GooseHarnessSettings = {
  /**
   * The provider's key under its `credentialEnv`, the only key used. The host environment is
   * never read.
   */
  readonly auth: HarnessV1AuthenticationEnvironment
  /** The provider Goose calls; unused on `vertex`. */
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
    GOOSE_PROVIDER: vertex ? GOOSE_VERTEX_PROVIDER_ID : (settings.provider?.id ?? ''),
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
 * Goose (`goose acp`) as an AI SDK harness, on a {@link GooseProvider} with its key, or on Vertex
 * AI. Thin config over `@ai-sdk/harness-acp`.
 *
 * Goose's ACP `PromptResponse.usage` is its last model call's, not the turn's, so the translator
 * drops it (see {@link GooseStreamTranslator}); each turn's usage is read instead from Goose's
 * `usage_ledger` in the sandbox, one row per model call (see {@link GooseLedger}).
 */
export function createGoose(settings: GooseHarnessSettings): HarnessV1<GooseBuiltinTools> {
  const { provider } = settings
  if (!provider && !settings.vertex) throw new Error('Goose needs a provider, or vertex')
  const credential = provider?.credentialEnv ?? ''
  if (
    !isHarnessAuthenticationEnvironment(settings.auth) ||
    (provider && !settings.vertex && !settings.auth[credential])
  ) {
    throw new Error(
      `Goose auth must be an environment object${provider ? ` with ${credential} (${/^[AEIOU]/.test(provider.name) ? 'an' : 'a'} ${provider.name} key)` : ''}`,
    )
  }
  const value = (key: string) => (provider?.scheme ? `${provider.scheme} ${key}` : key)
  const mcpServers = Object.keys(settings.mcpServers ?? {})
  const acp = createACP({
    version: 'v1',
    harnessId: GOOSE_HARNESS_ID,
    builtinTools: GOOSE_BUILTIN_TOOLS,
    // reeval gives the agent no host tools, and the stream translator names its MCP calls.
    resolveHostToolCall: () => undefined,
    isMcpToolCall: () => false,
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
      ANTHROPIC_PROVIDER.credentialEnv,
      OPENAI_PROVIDER.credentialEnv,
      XAI_PROVIDER.credentialEnv,
      AI_GATEWAY_PROVIDER.credentialEnv,
      OPENROUTER_PROVIDER.credentialEnv,
    ],
    credentialBrokering: ({ env, sandboxEnv, headers }) => {
      const key = env[credential]
      const placeholder = sandboxEnv?.[credential]
      if (settings.vertex || !provider || !key || !placeholder) return []
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
      const { abortSignal } = options
      const home = await resolveSandboxHomeDir({
        sandbox: options.sandboxSession,
        ...(abortSignal ? { abortSignal } : {}),
      })
      // After the bootstrap, which installs Goose's bin directory; the first turn runs it.
      await writeLauncher(options.sandboxSession, home, abortSignal)
      const ledger = new GooseLedger(options.sandboxSession, `${home}/${GOOSE_HOME}`)
      return translated(session, mcpServers, ledger)
    },
  }
}

/** Writes the launcher where `harness-acp` runs its executable from, executable. */
async function writeLauncher(
  sandbox: Experimental_SandboxSession,
  home: string,
  abortSignal?: AbortSignal,
) {
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
type Part = { type: string; [key: string]: unknown }
type Emit = (part: Part) => void
type Control = { done: PromiseLike<void> }

/**
 * The session, with each turn's parts through a fresh {@link GooseStreamTranslator}, and its
 * usage from Goose's ledger: the `finish` part is held until the turn is done, then sent with the
 * usage of the model calls the turn added to the ledger. The stream ends when `done` settles, so
 * `done` waits for that read.
 */
export function translated(
  session: Session,
  mcpServers: readonly string[],
  ledger: GooseLedger,
): Session {
  const turn =
    (run: (options: never) => Promise<Control>) =>
    async (options: { emit: Emit; abortSignal?: AbortSignal }) => {
      const translator = new GooseStreamTranslator({ mcpServers })
      await ledger.beforeTurn(options.abortSignal)
      let finish: Part | undefined
      const control = await run({
        ...options,
        emit: (part: Part) => {
          const out = translator.push(part)
          if (out.type === 'finish') finish = out
          else options.emit(out)
        },
      } as never)
      const done = Promise.resolve(control.done).then(
        async () => {
          if (!finish) return
          const usage = options.abortSignal?.aborted
            ? undefined
            : await ledger.afterTurn(options.abortSignal)
          options.emit(usage ? { ...finish, totalUsage: usage } : finish)
        },
        (error: unknown) => {
          if (finish) options.emit(finish)
          throw error
        },
      )
      return { ...control, done }
    }
  return new Proxy(session, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (key !== 'doPromptTurn' && key !== 'doContinueTurn') return value
      return turn(value.bind(target))
    },
  })
}
