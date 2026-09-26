import type { HarnessV1, HarnessV1AuthenticationEnvironment } from '@ai-sdk/harness'
import {
  createCredentialRequestTransformation,
  isHarnessAuthenticationEnvironment,
} from '@ai-sdk/harness/utils'
import { createACP } from '@ai-sdk/harness-acp'
import {
  OPENCODE_PACKAGE_JSON,
  OPENCODE_PNPM_LOCK,
  OPENCODE_PNPM_WORKSPACE,
} from './opencode-install.ts'
import { OpenCodeStreamTranslator } from './opencode-stream.ts'
import { OPENCODE_BUILTIN_TOOLS, type OpenCodeBuiltinTools } from './opencode-tools.ts'

export const OPENCODE_HARNESS_ID = 'opencode'
/** The `opencode-ai` release the bootstrap installs (pinned in `opencode-install.ts`). */
export const OPENCODE_CLI_VERSION = '1.18.32'
/** The only credential the adapter uses: a Gemini API key, for OpenCode's `google` provider. */
export const OPENCODE_CREDENTIAL_ENV = 'GOOGLE_GENERATIVE_AI_API_KEY'
export const GEMINI_API_URL = 'https://generativelanguage.googleapis.com'
/** The header OpenCode's `google` provider sends the key in. */
export const GEMINI_API_KEY_HEADER = 'x-goog-api-key'
/** Where harness-placed skills go, under the sandbox home: OpenCode's own global directory. */
export const OPENCODE_HOME_SKILLS_DIR = '.config/opencode/skills'
/** The repo skill directory OpenCode reads (with the Claude Code and `.agents` ones turned off). */
export const OPENCODE_WORKSPACE_SKILLS_DIR = '.opencode/skills'

/**
 * Installs the plugin runtime OpenCode otherwise installs into `~/.config/opencode` from npm on
 * every start (`@opencode-ai/plugin`, 63 MB at 1.18.32). An image that ran it starts offline.
 */
export const OPENCODE_WARM_COMMAND = `mkdir -p "$HOME/.config/opencode" && cd "$HOME/.config/opencode" && printf '{"dependencies":{"@opencode-ai/plugin":"%s"}}\\n' ${OPENCODE_CLI_VERSION} > package.json && npm install --no-fund --no-audit --ignore-scripts --loglevel=error`

/**
 * Keeps each run to what the eval set up: no self-update, share links, model-catalog fetch, LSP
 * downloads or default plugins, and none of the Claude Code or `.agents` files OpenCode would
 * otherwise also read (CLAUDE.md, `.claude/skills`, `~/.agents/skills`).
 */
export const OPENCODE_QUIET_ENV = {
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_SHARE: '1',
  OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
  OPENCODE_DISABLE_CLAUDE_CODE: '1',
  OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
} as const

export type OpenCodeHarnessSettings = {
  /** `{ GOOGLE_GENERATIVE_AI_API_KEY }`, the only key used. The host environment is never read. */
  readonly auth: HarnessV1AuthenticationEnvironment
  /** ACP `session/new` MCP servers, keyed by name. */
  readonly mcpServers?: Record<string, unknown>
  /** Refuse a sandbox that can't broker the key, rather than forwarding the real one. */
  readonly requireCredentialBrokering?: boolean
}

/**
 * The model-request endpoint OpenCode sends the key on, `POST /v1beta/models/<model>:
 * streamGenerateContent` (checked with 1.18.32, for the main model and the title model). A
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
 * model is a Gemini id such as `gemini-3.8-flash`, run as OpenCode's `google/gemini-3.8-flash`. `@ai-sdk/harness-opencode` brokers only Anthropic, OpenAI and a few other
 * providers' keys, so this is ES's own thin config over `@ai-sdk/harness-acp`.
 *
 * OpenCode's ACP `PromptResponse.usage` is its last model call's, not the turn's, so turns
 * report no usage here rather than an undercount (see {@link OpenCodeStreamTranslator}).
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
    executable: 'opencode',
    args: ['acp'],
    auth: settings.auth,
    env: OPENCODE_QUIET_ENV,
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
    ...(settings.mcpServers ? { mcpServers: settings.mcpServers } : {}),
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
      return translated(await acp.doStart(options), Object.keys(settings.mcpServers ?? {}))
    },
  }
}

type Session = Awaited<ReturnType<HarnessV1['doStart']>>
type Emit = (part: { type: string; [key: string]: unknown }) => void

/** OpenCode's id for a Gemini model: `gemini-3.8-flash` is `google/gemini-3.8-flash`. */
export const googleModel = (model: string) =>
  model.startsWith('google/') ? model : `google/${model}`

/** The session, with each turn's model on the `google` provider, and its parts through a fresh {@link OpenCodeStreamTranslator}. */
function translated(session: Session, mcpServers: readonly string[]): Session {
  const turn = (run: (options: never) => unknown) => (options: { emit: Emit; model?: string }) => {
    const translator = new OpenCodeStreamTranslator({ mcpServers })
    return run({
      ...options,
      ...(options.model ? { model: googleModel(options.model) } : {}),
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
