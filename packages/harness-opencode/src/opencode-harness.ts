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
import {
  openCodeProvider,
  providerEndpoints,
  providerTransformations,
  resolveOpenCodeProvider,
  splitModel,
} from './opencode-providers.ts'
import { OpenCodeStreamTranslator } from './opencode-stream.ts'
import { OPENCODE_BUILTIN_TOOLS, type OpenCodeBuiltinTools } from './opencode-tools.ts'

export const OPENCODE_HARNESS_ID = 'opencode'
/** The `@opencode/cli` release the bootstrap installs (pinned in `opencode-install.ts`). */
export const OPENCODE_CLI_VERSION = '2.1.4'
/** Where harness-placed skills go, under the sandbox home: OpenCode's own global directory. */
export const OPENCODE_HOME_SKILLS_DIR = '.config/opencode/skills'
/**
 * OpenCode's own repo skill directory. It also reads `.claude/skills` and `.agents/skills`, in
 * the repo and the home directory, and has no setting that turns that off.
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

/** Gemini's own thinking level, as Gemini's API takes it. */
const geminiThinking = (effort: string) => ({ thinkingConfig: { thinkingLevel: effort } })

/**
 * What OpenCode adds to the body of each call on `model` for `effort` (its config's per-model
 * `body`; OpenCode 2 has no per-model provider options), in the API's own field: Gemini's
 * `thinkingConfig` (Gemini's API and Vertex AI), Anthropic's `output_config.effort`, the Responses API's `reasoning.effort`,
 * OpenRouter's `reasoning.effort` (which it sends a Gemini model as its thinking level), and a
 * Gemini model's `thinkingConfig` under Vercel AI Gateway's `providerOptions` (Vercel's own effort
 * field maps every Gemini 3 level but `low` to `high`). Undefined for a provider whose field no
 * run has checked.
 */
export function openCodeEffortBody(
  model: string,
  effort: string,
): Record<string, unknown> | undefined {
  const parts = splitModel(model)
  if (parts?.provider === 'openrouter') return { reasoning: { effort } }
  if (parts?.provider === 'google' || parts?.provider === OPENCODE_VERTEX_PROVIDER)
    return { generationConfig: geminiThinking(effort) }
  if (parts?.provider === 'anthropic') return { output_config: { effort } }
  if (parts?.provider === 'openai') return { reasoning: { effort } }
  if (parts?.provider === 'vercel' && splitModel(parts.model)?.provider === 'google') {
    return { providerOptions: { google: geminiThinking(effort), vertex: geminiThinking(effort) } }
  }
  return undefined
}

/**
 * The config OpenCode runs with, as `OPENCODE_CONFIG_CONTENT` (not the
 * `OPENCODE_DISABLE_*` variables): no self-update or share links,
 * {@link OPENCODE_DENIED_TOOLS} off, web search on {@link OPENCODE_WEB_SEARCH},
 * session titles on the run's own model (OpenCode's default is a second, small one), the
 * provider's model calls over HTTP, and the MCP servers. It loads after an eval's own
 * `opencode.json(c)`: a key both set is reeval's, objects merge (MCP servers by name), and permission
 * rules append to the eval's.
 */
export function openCodeConfig(options: OpenCodeConfigOptions = {}) {
  const servers = Object.entries(options.mcpServers ?? {})
  const parts = options.model ? splitModel(options.model) : undefined
  const provider = parts?.provider
  const modelId = parts?.model
  const effortBody =
    options.model && options.effort ? openCodeEffortBody(options.model, options.effort) : undefined
  return {
    update: 'disable',
    share: 'disabled',
    // Appended to an eval's own rules, and the last match wins, so reeval only denies: anything that
    // asks is answered by harness-acp, which allows it.
    permissions: OPENCODE_DENIED_TOOLS.map((action) => ({ action, resource: '*', effect: 'deny' })),
    websearch: { provider: OPENCODE_WEB_SEARCH.provider },
    ...(options.model ? { agents: { title: { model: options.model } } } : {}),
    // HTTP rather than a Responses WebSocket (OpenCode's default for OpenAI and xAI): the gateway
    // reads the model that served each call from its HTTP response.
    ...(provider
      ? {
          providers: {
            [provider]: {
              settings: { transport: 'http' },
              ...(effortBody && modelId ? { models: { [modelId]: { body: effortBody } } } : {}),
            },
          },
        }
      : {}),
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

export type OpenCodeConfigOptions = {
  model?: string
  mcpServers?: OpenCodeHarnessSettings['mcpServers']
  /** Reasoning effort, in the request body's own field ({@link openCodeEffortBody}). */
  effort?: string
}

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
  /**
   * The provider's key, under the variable OpenCode reads it from (`{ ANTHROPIC_API_KEY }` for
   * `anthropic/…`), the only key used. The host environment is never read.
   */
  readonly auth: HarnessV1AuthenticationEnvironment
  /**
   * The model the turns run on, as OpenCode names it, `<provider>/<model>` (such as
   * `google/gemini-3.8-flash`), which picks the provider whose key is brokered. OpenCode also
   * titles the session with it, rather than with a second, small model of its own.
   */
  readonly model: string
  /**
   * The provider's variables besides its key, which aren't secret and go into the sandbox as they
   * are: Bedrock's `AWS_REGION`, which its hosts are built from (default `us-east-1`).
   */
  readonly vars?: Record<string, string>
  /**
   * MCP servers, keyed by name, which go in OpenCode's config with `codemode: false`, so its
   * model calls their tools directly. Over ACP `session/new`, OpenCode offers them only
   * through Code Mode (`execute`), which reports no call's input or output.
   */
  readonly mcpServers?: Record<string, OpenCodeMcpServer>
  /** Refuse a sandbox that can't broker the key, rather than forwarding the real one. */
  readonly requireCredentialBrokering?: boolean
  /**
   * Reasoning effort, in the field the model's provider takes it in ({@link openCodeEffortBody}).
   * Values are whatever that field takes; a provider with no such field is refused.
   */
  readonly effort?: string
  /**
   * Vertex AI instead of a key: OpenCode's `google-vertex` provider on this project and region,
   * reading the service-account file at `credentialsFile` in the sandbox, for a
   * `google-vertex/<model>` id. No key is read (`auth` may be empty); whoever runs the sandbox
   * supplies the file and the token the calls carry.
   */
  readonly vertex?: OpenCodeVertex
}

export type OpenCodeVertex = {
  readonly project: string
  readonly location: string
  readonly credentialsFile: string
}

/** OpenCode's provider for Vertex AI, which authenticates from Application Default Credentials. */
export const OPENCODE_VERTEX_PROVIDER = 'google-vertex'

/**
 * The requests OpenCode sends the model's provider's key on (see
 * `opencode-provider-table.ts`). A gateway that enforces them refuses the key anywhere else.
 */
export const openCodeEndpoints = (model: string, env: Record<string, string | undefined> = {}) =>
  providerEndpoints(openCodeProvider(model, env))

/**
 * OpenCode (`opencode acp`) as an AI SDK harness, on any provider whose key it sends in a header
 * on known hosts: the model's provider (`anthropic/claude-haiku-4-5` runs on `anthropic`) picks
 * the key, and only that key is used and brokered.
 *
 * OpenCode ignores its config's `model` over ACP (a session starts on its own default), so each
 * turn sets the session's `model` config option. `@ai-sdk/harness-acp` maps
 * `PromptResponse.usage` onto the `finish` part (the whole turn)
 * (see {@link OpenCodeStreamTranslator}).
 */
export function createOpenCode(settings: OpenCodeHarnessSettings): HarnessV1<OpenCodeBuiltinTools> {
  const route = settings.vertex ? vertexRoute(settings, settings.vertex) : keyRoute(settings)
  if (settings.effort && !openCodeEffortBody(settings.model, settings.effort)) {
    throw new Error(
      `OpenCode's effort on ${settings.model} goes in no field reeval has checked the model reads; drop effort, or run a model on Google, Vertex AI, Anthropic, OpenAI or OpenRouter, or a Gemini model on Vercel AI Gateway`,
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
    env: { ...openCodeEnv(settings), ...route.env },
    ...(route.credentialBrokering
      ? { credentialEnv: route.credentialEnv, credentialBrokering: route.credentialBrokering }
      : {}),
    modelMapping: { type: 'session-config-option', path: 'model' },
    skillsDirectory: OPENCODE_HOME_SKILLS_DIR,
  })
  return {
    ...acp,
    doStart: async (options) => {
      const sandbox = options.sandboxSession as { addRequestTransformations?: unknown }
      if (
        route.credentialEnv.length > 0 &&
        settings.requireCredentialBrokering &&
        typeof sandbox.addRequestTransformations !== 'function'
      ) {
        throw new Error(
          `The sandbox can't broker ${route.credentialEnv.join(', ')} (it has no request transformations), and requireCredentialBrokering is set, so the key stays out of it.`,
        )
      }
      const session = await acp.doStart(options)
      // After the bootstrap, which installs OpenCode's bin directory; the first turn runs it.
      await writeGate(options.sandboxSession, options.abortSignal)
      return translated(session, route, Object.keys(settings.mcpServers ?? {}))
    },
  }
}

/** Where OpenCode's model calls go, and the key (if any) the sandbox gets for them. */
type Route = {
  readonly id: string
  readonly name: string
  readonly env: Record<string, string>
  readonly credentialEnv: string[]
  readonly credentialBrokering?: Parameters<typeof createACP>[0]['credentialBrokering']
  /** Why this route can't run a turn's model, or undefined when it can. */
  readonly refuses: (model: string) => string | undefined
}

function keyRoute(settings: OpenCodeHarnessSettings): Route {
  const resolved = resolveOpenCodeProvider(settings.model, settings.vars ?? {})
  if ('error' in resolved) throw new Error(resolved.error)
  const { provider, vars } = resolved
  if (!isHarnessAuthenticationEnvironment(settings.auth) || !settings.auth[provider.env]) {
    throw new Error(
      `OpenCode auth must be an environment object with ${provider.env} (the ${provider.name} key for ${settings.model})`,
    )
  }
  return {
    id: provider.id,
    name: provider.name,
    env: vars,
    credentialEnv: [provider.env],
    credentialBrokering: ({ env, sandboxEnv, headers }) => {
      const key = env[provider.env]
      const placeholder = sandboxEnv?.[provider.env]
      if (!key || !placeholder) return []
      return providerTransformations(provider, {
        key,
        placeholder,
        ...(headers ? { headers } : {}),
      }).map(createCredentialRequestTransformation)
    },
    refuses: (model) =>
      openCodeProvider(model).id === provider.id
        ? undefined
        : `OpenCode was started with ${provider.name}'s key, so it can't run ${model}`,
  }
}

function vertexRoute(settings: OpenCodeHarnessSettings, vertex: OpenCodeVertex): Route {
  const onVertex = (model: string) => splitModel(model)?.provider === OPENCODE_VERTEX_PROVIDER
  if (!onVertex(settings.model)) {
    throw new Error(
      `OpenCode on Vertex AI runs a ${OPENCODE_VERTEX_PROVIDER}/<model> id, such as '${OPENCODE_VERTEX_PROVIDER}/gemini-3.8-flash' (got ${JSON.stringify(settings.model)})`,
    )
  }
  return {
    id: OPENCODE_VERTEX_PROVIDER,
    name: 'Vertex AI',
    env: {
      GOOGLE_CLOUD_PROJECT: vertex.project,
      GOOGLE_VERTEX_LOCATION: vertex.location,
      GOOGLE_APPLICATION_CREDENTIALS: vertex.credentialsFile,
    },
    credentialEnv: [],
    refuses: (model) =>
      onVertex(model) ? undefined : `OpenCode was started on Vertex AI, so it can't run ${model}`,
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

/**
 * The session, with each turn's model checked against the provider whose key it has, and its
 * parts through a fresh {@link OpenCodeStreamTranslator}.
 */
function translated(session: Session, route: Route, mcpServers: readonly string[]): Session {
  const turn = (run: (options: never) => unknown) => (options: { emit: Emit; model?: string }) => {
    const refused = options.model ? route.refuses(options.model) : undefined
    if (refused) throw new Error(refused)
    const translator = new OpenCodeStreamTranslator({ mcpServers })
    return run({
      ...options,
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
