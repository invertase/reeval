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
  OPENCODE_GATE,
  OPENCODE_GATE_EXECUTABLE,
  OPENCODE_GATE_PATH,
  OPENCODE_GATE_SERVERS_ENV,
} from './opencode-gate.ts'
import {
  OPENCODE_PACKAGE_JSON,
  OPENCODE_PNPM_LOCK,
  OPENCODE_PNPM_WORKSPACE,
} from './opencode-install.ts'
import { OpenCodeStreamTranslator } from './opencode-stream.ts'
import { OPENCODE_BUILTIN_TOOLS, type OpenCodeBuiltinTools } from './opencode-tools.ts'

export const OPENCODE_HARNESS_ID = 'opencode'
/** The `@opencode/cli` release the bootstrap installs (pinned in `opencode-install.ts`). */
export const OPENCODE_CLI_VERSION = '2.0.18'
/** The only credential the adapter uses: a Gemini API key, for OpenCode's `google` provider. */
export const OPENCODE_CREDENTIAL_ENV = 'GOOGLE_GENERATIVE_AI_API_KEY'
export const GEMINI_API_URL = 'https://generativelanguage.googleapis.com'
/** The header OpenCode's `google` provider sends the key in. */
export const GEMINI_API_KEY_HEADER = 'x-goog-api-key'
/** Where harness-placed skills go, under the sandbox home: OpenCode's own global directory. */
export const OPENCODE_HOME_SKILLS_DIR = '.config/opencode/skills'
/**
 * OpenCode's own repo skill directory. It also reads `.claude/skills` and `.agents/skills`, in
 * the repo and the home directory, and 2.0.18 has no setting that turns that off.
 */
export const OPENCODE_WORKSPACE_SKILLS_DIR = '.opencode/skills'

/**
 * The tools OpenCode offers that can't work in an eval, which the config turns off: `question`
 * waits for a person to answer, and `browser` drives a desktop browser.
 */
export const OPENCODE_DENIED_TOOLS = ['question', 'browser'] as const

/**
 * The search service `websearch` uses: Exa's hosted MCP server, keyless. Without a provider in
 * the config, the tool asks the user to pick one, which in an eval ends "Web search cancelled".
 */
export const OPENCODE_WEB_SEARCH = { provider: 'exa', host: 'mcp.exa.ai' } as const

/**
 * The config OpenCode runs with, as `OPENCODE_CONFIG_CONTENT` (2.0.18 no longer reads the
 * `OPENCODE_DISABLE_*` variables for these): no self-update or share links,
 * {@link OPENCODE_DENIED_TOOLS} off, web search on {@link OPENCODE_WEB_SEARCH},
 * session titles on the run's own model (OpenCode's default is a second one,
 * `gemini-flash-lite-latest`), and the MCP servers. It loads after an eval's own
 * `opencode.json(c)`: a key both set is ES's, objects merge (MCP servers by name), and permission
 * rules append to the eval's.
 */
export function openCodeConfig(options: OpenCodeConfigOptions = {}) {
  const servers = Object.entries(options.mcpServers ?? {})
  return {
    update: 'disable',
    share: 'disabled',
    // Appended to an eval's own rules, and the last match wins, so ES only denies: anything that
    // asks is answered by harness-acp, which allows it.
    permissions: OPENCODE_DENIED_TOOLS.map((action) => ({ action, resource: '*', effect: 'deny' })),
    websearch: { provider: OPENCODE_WEB_SEARCH.provider },
    ...(options.model ? { agents: { title: { model: googleModel(options.model) } } } : {}),
    ...(servers.length
      ? {
          mcp: {
            servers: Object.fromEntries(
              servers.map(([name, server]) => [name, { ...server, codemode: false }]),
            ),
          },
        }
      : {}),
  }
}

export type OpenCodeConfigOptions = Pick<OpenCodeHarnessSettings, 'model' | 'mcpServers'>

/**
 * The environment `opencode acp` runs with: its config, and no self-update or model-catalog
 * fetch (it uses the catalog built into the release).
 */
export const openCodeEnv = (options: OpenCodeConfigOptions = {}) => ({
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeConfig(options)),
  [OPENCODE_GATE_SERVERS_ENV]: JSON.stringify(Object.keys(options.mcpServers ?? {})),
})

/**
 * An MCP server in OpenCode's config: `{ type: 'local', command: [cmd, ...args], environment }`
 * or `{ type: 'remote', url, headers }`.
 */
export type OpenCodeMcpServer =
  | { type: 'local'; command: string[]; environment?: Record<string, string> }
  | { type: 'remote'; url: string; headers?: Record<string, string>; oauth?: false }

export type OpenCodeHarnessSettings = {
  /** `{ GOOGLE_GENERATIVE_AI_API_KEY }`, the only key used. The host environment is never read. */
  readonly auth: HarnessV1AuthenticationEnvironment
  /**
   * The Gemini model id the turns run on, which OpenCode also titles the session with. Without
   * it, OpenCode titles it with its own small model, a second model in the requests.
   */
  readonly model?: string
  /**
   * MCP servers, keyed by name, which go in OpenCode's config with `codemode: false`, so its
   * model calls their tools directly. Over ACP `session/new`, OpenCode 2.0.18 offers them only
   * through Code Mode (`execute`), which reports no call's input or output.
   */
  readonly mcpServers?: Record<string, OpenCodeMcpServer>
  /** Refuse a sandbox that can't broker the key, rather than forwarding the real one. */
  readonly requireCredentialBrokering?: boolean
}

/**
 * The model-request endpoint OpenCode sends the key on, `POST /v1beta/models/<model>:
 * streamGenerateContent` (checked with 2.0.18, for the main model and the title model). A
 * gateway that enforces it refuses the key anywhere else.
 */
export const OPENCODE_ENDPOINTS = [
  {
    host: new URL(GEMINI_API_URL).hostname,
    path: { regex: '^/v1beta/models/[^/]+:streamGenerateContent$' },
    method: ['POST'],
  },
] as const

/**
 * OpenCode (`opencode acp`) as an AI SDK harness, on Google models with a Gemini API key: a
 * model is a Gemini id such as `gemini-3.8-flash`, run as OpenCode's `google/gemini-3.8-flash`.
 * `@ai-sdk/harness-opencode` brokers only Anthropic, OpenAI and a few other providers' keys, so
 * this is ES's own thin config over `@ai-sdk/harness-acp`.
 *
 * OpenCode ignores its config's `model` over ACP (a session starts on its own default), so each
 * turn sets the session's `model` config option. Its ACP `PromptResponse.usage` is its last
 * model call's, not the turn's, so turns report no usage here rather than an undercount (see
 * {@link OpenCodeStreamTranslator}).
 */
export function createOpenCode(settings: OpenCodeHarnessSettings): HarnessV1<OpenCodeBuiltinTools> {
  if (
    !isHarnessAuthenticationEnvironment(settings.auth) ||
    !settings.auth[OPENCODE_CREDENTIAL_ENV]
  ) {
    throw new Error(
      `OpenCode auth must be an environment object with ${OPENCODE_CREDENTIAL_ENV} (a Gemini API key)`,
    )
  }
  const acp = createACP({
    version: 'v1',
    harnessId: OPENCODE_HARNESS_ID,
    builtinTools: OPENCODE_BUILTIN_TOOLS,
    source: {
      type: 'npm-locked',
      packageJson: OPENCODE_PACKAGE_JSON,
      pnpmLockYaml: OPENCODE_PNPM_LOCK,
      pnpmWorkspaceYaml: OPENCODE_PNPM_WORKSPACE,
    },
    // The gate, which runs `opencode acp` (see OPENCODE_GATE).
    executable: OPENCODE_GATE_EXECUTABLE,
    args: [],
    auth: settings.auth,
    env: openCodeEnv(settings),
    credentialEnv: [OPENCODE_CREDENTIAL_ENV],
    credentialBrokering: ({ env, sandboxEnv, headers }) => {
      const key = env[OPENCODE_CREDENTIAL_ENV]
      const placeholder = sandboxEnv?.[OPENCODE_CREDENTIAL_ENV]
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
    skillsDirectory: OPENCODE_HOME_SKILLS_DIR,
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
          `The sandbox can't broker ${OPENCODE_CREDENTIAL_ENV} (it has no request transformations), and requireCredentialBrokering is set, so the key stays out of it.`,
        )
      }
      const session = await acp.doStart(options)
      // After the bootstrap, which installs OpenCode's bin directory; the first turn runs it.
      await writeGate(options.sandboxSession, options.abortSignal)
      return translated(session, Object.keys(settings.mcpServers ?? {}))
    },
  }
}

/** Writes the gate where `harness-acp` runs its executable from, executable. */
async function writeGate(sandbox: Experimental_SandboxSession, abortSignal?: AbortSignal) {
  const home = await resolveSandboxHomeDir({ sandbox, ...(abortSignal ? { abortSignal } : {}) })
  const path = `${home}/${OPENCODE_GATE_PATH}`
  await sandbox.run({
    command: `mkdir -p ${shellQuote(path.slice(0, path.lastIndexOf('/')))}`,
    abortSignal,
  })
  await sandbox.writeTextFile({ path, content: OPENCODE_GATE, abortSignal })
  const chmod = await sandbox.run({ command: `chmod 755 ${shellQuote(path)}`, abortSignal })
  if (chmod.exitCode !== 0) throw new Error(`OpenCode's gate isn't executable: ${path}`)
}

type Session = Awaited<ReturnType<HarnessV1['doStart']>>
type Emit = (part: { type: string; [key: string]: unknown }) => void

/** OpenCode's id for a Gemini model: `gemini-3.8-flash` is `google/gemini-3.8-flash`. */
export const googleModel = (model: string) =>
  model.startsWith('google/') ? model : `google/${model}`

/**
 * The session, with each turn's model on the `google` provider, and its parts through a fresh
 * {@link OpenCodeStreamTranslator}.
 */
function translated(session: Session, mcpServers: readonly string[]): Session {
  const turn = (run: (options: never) => unknown) => (options: { emit: Emit; model?: string }) => {
    const translator = new OpenCodeStreamTranslator({ mcpServers })
    return run({
      ...options,
      ...(options.model ? { model: googleModel(options.model) } : {}),
      emit: (part: Parameters<Emit>[0]) => {
        for (const out of translator.push(part)) options.emit(out)
      },
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
