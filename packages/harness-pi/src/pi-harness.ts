import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import {
  HarnessCapabilityUnsupportedError,
  type HarnessV1,
  type HarnessV1AuthenticationEnvironment,
  type HarnessV1NetworkSandboxSession,
  type HarnessV1Prompt,
  type HarnessV1PromptControl,
  type HarnessV1ResumeSessionState,
  type HarnessV1Session,
  type HarnessV1StartOptions,
  type HarnessV1StreamPart,
  harnessSessionDataDirectoryPath,
  harnessStateDirectoryPath,
} from '@ai-sdk/harness'
import {
  createCredentialRequestTransformation,
  generateSandboxCredentialPlaceholder,
  isHarnessAuthenticationEnvironment,
  resolveSandboxHomeDir,
  shellQuote,
  writeInstructions,
  writeSkills,
} from '@ai-sdk/harness/utils'
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils'
import { z } from 'zod'
import {
  getPiBootstrap,
  PI_BOOTSTRAP_DIR,
  PI_CLI_PATH,
  piGatewayModelsScript,
} from './pi-bootstrap.ts'
import type { PiProvider } from './pi-providers.ts'
import { PiStreamTranslator } from './pi-stream.ts'
import { PI_BUILTIN_TOOLS, type PiBuiltinTools } from './pi-tools.ts'

export const PI_HARNESS_ID = 'pi'
/** pi's provider for Vertex AI, which authenticates from Application Default Credentials. */
export const PI_VERTEX_PROVIDER = 'google-vertex'
/** pi's agent directory under the home: its sessions, settings, global skills and rules. */
export const PI_AGENT_DIR = '.pi/agent'
/** Where harness-placed skills go, under the sandbox home. */
export const PI_HOME_SKILLS_DIR = `${PI_AGENT_DIR}/skills`
/** Global rules, which pi loads before the workspace's; `instructions` go here. */
export const PI_INSTRUCTIONS_FILE = `${PI_AGENT_DIR}/AGENTS.md`
/** The repo skill directory pi reads when the project is trusted (`--approve`). */
export const PI_WORKSPACE_SKILLS_DIR = '.pi/skills'
/** pi's global MCP config, which its built-in `mcp` extension reads. */
export const PI_MCP_FILE = `${PI_AGENT_DIR}/mcp.json`

/** pi's model list, which a {@link PiGateway}'s provider goes in. */
export const PI_MODELS_FILE = `${PI_AGENT_DIR}/models.json`

/**
 * An AI gateway pi reaches a model through, whose ids name their provider
 * (`anthropic/claude-haiku-4.5`). Each turn writes the model to `models.json` in a provider of
 * reeval's, `id`: an Anthropic model on the gateway's Anthropic Messages API, any other on its
 * Chat Completions API, with the key sent as a Bearer token (and in `x-api-key`, on Messages).
 */
export type PiGateway = {
  /** For messages: `Vercel AI Gateway`. */
  readonly name: string
  /** reeval's pi provider id, `--provider`. */
  readonly id: string
  readonly credentialEnv: string
  /** The Chat Completions base URL, ending `/v1`. */
  readonly openai: string
  /** The Anthropic Messages base URL, which pi adds `/v1/messages` to. */
  readonly anthropic: string
  /** pi's own provider for the gateway, whose catalog has the model's limits when it lists it. */
  readonly catalog: string
  /**
   * How a model runs, by the provider its id names (`google` in `google/gemini-3.8-flash`). A
   * provider with no route runs on the Chat Completions API, described by pi's catalog for the
   * gateway or the provider, else `PiModelInfo`.
   */
  readonly routes: Readonly<Record<string, PiGatewayRoute>>
}

/** How a {@link PiGateway} runs one provider's models. */
export type PiGatewayRoute =
  /** On pi's own provider for the gateway (`--provider <catalog>`), not one of reeval's. */
  | { readonly builtin: true }
  | {
      readonly builtin?: false
      /** The gateway's API it goes on; default `openai-completions`. */
      readonly api?: 'anthropic-messages' | 'openai-completions'
      /**
       * Each thinking level goes as the model's native `thinkingConfig`, under these
       * `providerOptions` keys: the model must be in pi's `thinkingCatalog` and take a level.
       */
      readonly thinkingConfig?: { readonly catalog: string; readonly upstreams: readonly string[] }
    }

/**
 * Vercel AI Gateway. It takes Gemini's own `thinkingConfig` under the provider that serves the
 * call, Google's or Vertex's: its `reasoning_effort` maps every Gemini 3 level but `low` to `high`.
 */
export const PI_AI_GATEWAY: PiGateway = {
  name: 'Vercel AI Gateway',
  id: 'reeval-ai-gateway',
  credentialEnv: 'AI_GATEWAY_API_KEY',
  openai: 'https://ai-gateway.vercel.sh/v1',
  anthropic: 'https://ai-gateway.vercel.sh',
  catalog: 'vercel-ai-gateway',
  routes: {
    anthropic: { api: 'anthropic-messages' },
    google: { thinkingConfig: { catalog: 'google', upstreams: ['google', 'vertex'] } },
  },
}

/**
 * OpenRouter. A Gemini model runs on pi's own `openrouter` provider, whose `reasoning.effort`
 * OpenRouter sends Gemini as the same thinking level.
 */
export const PI_OPENROUTER: PiGateway = {
  name: 'OpenRouter',
  id: 'reeval-openrouter',
  credentialEnv: 'OPENROUTER_API_KEY',
  openai: 'https://openrouter.ai/api/v1',
  anthropic: 'https://openrouter.ai/api',
  catalog: 'openrouter',
  routes: { anthropic: { api: 'anthropic-messages' }, google: { builtin: true } },
}

/** The model calls pi makes on a {@link PiGateway}, which it streams. */
export const piGatewayEndpoints = (gateway: PiGateway) =>
  [
    {
      host: new URL(gateway.openai).hostname,
      path: { exact: `${new URL(gateway.openai).pathname}/chat/completions` },
      method: ['POST'],
    },
    {
      host: new URL(gateway.anthropic).hostname,
      path: { exact: `${new URL(gateway.anthropic).pathname.replace(/\/$/, '')}/v1/messages` },
      method: ['POST'],
    },
  ] as const

/**
 * What pi needs to know of a model its catalog doesn't list, from another source (models.dev):
 * it defaults to a 128,000-token context window and 16,384 output tokens, and no thinking.
 */
export type PiModelInfo = {
  readonly name?: string
  readonly reasoning: boolean
  readonly input: readonly ('text' | 'image')[]
  readonly contextWindow: number
  readonly maxTokens: number
}

const routeOf = (gateway: PiGateway, model: string): PiGatewayRoute | undefined =>
  gateway.routes[model.slice(0, Math.max(0, model.indexOf('/')))]

/**
 * Whether pi's own catalogs describe `model` on `gateway`, so it needs no `PiModelInfo`: a route
 * that runs it on pi's provider, or takes its thinking levels from pi's catalog.
 */
export const piGatewayDescribes = (gateway: PiGateway, model: string): boolean => {
  const route = routeOf(gateway, model)
  return !!route && (route.builtin === true || 'thinkingConfig' in route)
}

/** An `mcp.json` server: stdio (`command`) or streamable HTTP (`url`); pi has no SSE transport. */
export type PiMcpServer =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { url: string; headers?: Record<string, string> }

export type PiHarnessSettings = {
  /**
   * The provider's or the gateway's key under its `credentialEnv`: the only key used. The host
   * environment is never read.
   */
  readonly auth: HarnessV1AuthenticationEnvironment
  /**
   * The provider pi calls with its own key (`piProvider('anthropic')`), Vertex AI's when
   * `vertex` is set; unused on a `gateway`.
   */
  readonly provider?: PiProvider
  /**
   * Run the model on this gateway rather than a provider's API: a model is the gateway's id
   * (`anthropic/claude-haiku-4.5`). A Gemini one must be in pi's catalog, and take a thinking
   * level where its native `thinkingConfig` is sent; any other is in pi's catalog for the gateway
   * or its provider, or described by `modelInfo`.
   */
  readonly gateway?: PiGateway
  /** The gateway model's limits, for a model pi's catalogs don't list. */
  readonly modelInfo?: PiModelInfo
  /** MCP servers by name, written to pi's `mcp.json` with their tools declared to the model. */
  readonly mcpServers?: Record<string, PiMcpServer>
  /** Refuse a sandbox that can't broker the key, rather than forwarding the real one. */
  readonly requireCredentialBrokering?: boolean
  /**
   * Reasoning effort, passed as `--thinking` (pi's name). Values are whatever that flag takes.
   */
  readonly effort?: string
  /**
   * Vertex AI instead of the Gemini API: pi's `google-vertex` provider on this project and
   * region, reading the service-account file at `credentialsFile` in the sandbox. No key is read
   * (`auth` may be empty); whoever runs the sandbox supplies the file and the token the calls
   * carry.
   */
  readonly vertex?: PiVertex
}

export type PiVertex = {
  readonly project: string
  readonly location: string
  readonly credentialsFile: string
}

/**
 * A literal `env` or header value for `mcp.json`, where pi expands `$NAME` and `${NAME}` and runs
 * a value starting with `!` as a shell command: `$$` is a `$` and a leading `$!` is a `!`.
 */
export function escapePiConfigValue(value: string): string {
  const escaped = value.replaceAll('$', () => '$$')
  return escaped.startsWith('!') ? `$${escaped}` : escaped
}

const escapeValues = (values: Record<string, string>) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, escapePiConfigValue(v)]))

/**
 * pi's `mcp.json`. Each server has `direct` exposure, so its tools are declared to the model as
 * `mcp__<server>__<tool>`: the default, `codemode`, reaches them only from the `codemode` tool,
 * which `--no-extensions` leaves out.
 */
export function buildPiMcpConfig(servers: Record<string, PiMcpServer>): string {
  const mcpServers = Object.fromEntries(
    Object.entries(servers).map(([name, s]) => [
      name,
      'url' in s
        ? { url: s.url, headers: escapeValues(s.headers ?? {}), exposure: 'direct' }
        : {
            command: s.command,
            args: s.args ?? [],
            env: escapeValues(s.env ?? {}),
            exposure: 'direct',
          },
    ]),
  )
  return `${JSON.stringify({ mcpServers, autoEnableCodemode: false }, null, 2)}\n`
}

const lifecycleData = z.object({ sessionId: z.string() })

const unsupported = (what: string) =>
  new HarnessCapabilityUnsupportedError({
    message: `pi's print mode has no ${what}`,
    harnessId: PI_HARNESS_ID,
  })

function promptText(prompt: HarnessV1Prompt): string {
  if (typeof prompt === 'string') return prompt
  const { content } = prompt
  if (typeof content === 'string') return content
  return content
    .map((part) => {
      if (part.type !== 'text') {
        throw new HarnessCapabilityUnsupportedError({
          message: `pi takes text prompts only (got a ${part.type} part)`,
          harnessId: PI_HARNESS_ID,
        })
      }
      return part.text
    })
    .join('\n')
}

const lines = (stream: ReadableStream<Uint8Array>) =>
  createInterface({ input: Readable.fromWeb(stream as WebReadableStream), crlfDelay: Infinity })

async function tail(stream: ReadableStream<Uint8Array>, max = 4000): Promise<string> {
  let text = ''
  for await (const line of lines(stream)) text = `${text}${line}\n`.slice(-max)
  return text
}

const canBroker = (
  sandbox: HarnessV1NetworkSandboxSession | SandboxSession,
): sandbox is HarnessV1NetworkSandboxSession &
  Required<Pick<HarnessV1NetworkSandboxSession, 'addRequestTransformations'>> =>
  'addRequestTransformations' in sandbox && typeof sandbox.addRequestTransformations === 'function'

/**
 * The pi turn command: print mode with JSON events, the project trusted (so its `.pi/skills`
 * load), no extensions (but the built-in `mcp` one, when there are MCP servers) or startup
 * network operations, one session id for every turn. The prompt is an argument, so it must stay
 * under the shell's 128 KiB.
 */
export function buildPiCommand(options: {
  cli: string
  workDir: string
  promptFile: string
  model: string | undefined
  sessionId: string
  sessionDir: string
  mcp?: boolean
  thinking?: string
  /** The pi provider, `--provider`. */
  provider: string
  /** A command that must succeed before pi starts, such as writing its models.json. */
  before?: string
}): string {
  return [
    `cd ${shellQuote(options.workDir)} &&`,
    ...(options.before ? [`${options.before} &&`] : []),
    `exec ${shellQuote(options.cli)} --mode json -p --offline --approve --no-extensions`,
    ...(options.mcp ? ['-e builtin:mcp'] : []),
    `--provider ${shellQuote(options.provider)}`,
    ...(options.model ? [`--model ${shellQuote(options.model)}`] : []),
    ...(options.thinking ? [`--thinking ${shellQuote(options.thinking)}`] : []),
    `--session-id ${shellQuote(options.sessionId)} --session-dir ${shellQuote(options.sessionDir)}`,
    `-- "$(cat ${shellQuote(options.promptFile)})"`,
  ].join(' ')
}

/**
 * pi (`pi --mode json`) as an AI SDK harness, in the sandbox: one process per turn, resumed by
 * session id, its NDJSON translated into harness stream parts with each model call's tokens.
 * Unlike `@ai-sdk/harness-pi`, nothing runs on the host: pi, its model calls and its tools are
 * all in the sandbox, MCP servers included.
 */
export function createPi(settings: PiHarnessSettings): HarnessV1<PiBuiltinTools> {
  if (settings.vertex) {
    return harness(settings, { id: PI_VERTEX_PROVIDER, credentialEnv: '', endpoints: [] })
  }
  const provider = keyedProvider(settings)
  const { credentialEnv, id } = provider
  const key = isHarnessAuthenticationEnvironment(settings.auth)
    ? settings.auth[credentialEnv]
    : undefined
  if (!key) {
    throw new Error(
      `pi auth must be an environment object with ${credentialEnv} (pi's ${id} provider's key)`,
    )
  }
  return harness(settings, provider, key)
}

function harness(
  settings: PiHarnessSettings,
  provider: PiProvider,
  key?: string,
): HarnessV1<PiBuiltinTools> {
  return {
    specificationVersion: 'harness-v1',
    harnessId: PI_HARNESS_ID,
    builtinTools: PI_BUILTIN_TOOLS,
    lifecycleStateSchema: lifecycleData,
    getBootstrap: getPiBootstrap,
    doStart: (options) => startSession(settings, provider, key, options),
  }
}

/** What pi calls with the key: the gateway's provider of reeval's, else `provider`. */
function keyedProvider({ gateway, provider }: PiHarnessSettings): PiProvider {
  if (gateway) {
    const [chat, messages] = piGatewayEndpoints(gateway)
    const bearer = { name: 'authorization', scheme: 'Bearer' }
    return {
      id: gateway.id,
      credentialEnv: gateway.credentialEnv,
      endpoints: [
        { ...chat, api: 'openai-completions', headers: [bearer] },
        { ...messages, api: 'anthropic-messages', headers: [bearer, { name: 'x-api-key' }] },
      ],
    }
  }
  if (!provider) throw new Error('pi needs a provider, a gateway or vertex')
  return provider
}

/** Each host and header pi sends the key in, once. */
const keyHeaders = (provider: PiProvider) => [
  ...new Map(
    provider.endpoints.flatMap(({ host, headers }) =>
      headers.map((h) => [`${host} ${h.name} ${h.scheme}`, { host, ...h }] as const),
    ),
  ).values(),
]

async function startSession(
  settings: PiHarnessSettings,
  provider: PiProvider,
  key: string | undefined,
  options: HarnessV1StartOptions,
): Promise<HarnessV1Session> {
  const { sandboxSession: sandbox, sessionWorkDir, abortSignal } = options
  const { gateway, vertex } = settings
  const { credentialEnv: credential } = provider
  let sandboxKey = key
  if (!key || vertex) {
    sandboxKey = undefined
  } else if (canBroker(sandbox)) {
    const placeholder = generateSandboxCredentialPlaceholder()
    sandboxKey = placeholder
    await sandbox.addRequestTransformations(
      keyHeaders(provider).map(({ host, name, scheme }) => {
        const sent = (value: string) => (scheme ? `${scheme} ${value}` : value)
        return createCredentialRequestTransformation({
          matchUrl: `https://${host}`,
          matchHeaders: { [name]: sent(placeholder) },
          transformHeaders: { ...options.headers, [name]: sent(key) },
        })
      }),
    )
  } else if (settings.requireCredentialBrokering) {
    throw new Error(
      `The sandbox can't broker ${credential} (it has no request transformations), and requireCredentialBrokering is set, so the key stays out of it.`,
    )
  }

  const home = await resolveSandboxHomeDir({ sandbox, abortSignal })
  const stateDir = harnessStateDirectoryPath({ sandboxHomeDir: home })
  const cli = posix.join(stateDir, PI_BOOTSTRAP_DIR, PI_CLI_PATH)
  const dataDir = harnessSessionDataDirectoryPath({
    stateDirectory: stateDir,
    sessionId: options.sessionId,
  })
  const resumed = lifecycleData.safeParse(options.resumeFrom?.data)
  const piSession = resumed.success ? resumed.data.sessionId : randomUUID()
  const env: Record<string, string> = vertex
    ? {
        GOOGLE_CLOUD_PROJECT: vertex.project,
        GOOGLE_CLOUD_LOCATION: vertex.location,
        GOOGLE_APPLICATION_CREDENTIALS: vertex.credentialsFile,
        PI_OFFLINE: '1',
      }
    : { [credential]: sandboxKey ?? '', PI_OFFLINE: '1' }
  const bootstrapDir = posix.join(stateDir, PI_BOOTSTRAP_DIR)
  const modelsScript = posix.join(dataDir, 'gateway-models.mjs')
  if (gateway) {
    await sandbox.writeTextFile({
      path: modelsScript,
      content: await piGatewayModelsScript(),
      abortSignal,
    })
  }
  const builtin = (model: string) => !!gateway && routeOf(gateway, model)?.builtin === true
  const writeModels = (model: string) =>
    gateway && !builtin(model)
      ? [
          'node',
          ...[modelsScript, bootstrapDir, posix.join(home, PI_MODELS_FILE)],
          ...[JSON.stringify(gateway), model, JSON.stringify(settings.modelInfo ?? null)],
        ]
          .map(shellQuote)
          .join(' ')
      : undefined
  const mcp = Object.keys(settings.mcpServers ?? {}).length > 0
  if (mcp) {
    await sandbox.writeTextFile({
      path: posix.join(home, PI_MCP_FILE),
      content: buildPiMcpConfig(settings.mcpServers ?? {}),
      abortSignal,
    })
  }
  let turns = 0
  let running: { kill(): PromiseLike<void> } | undefined
  let ended = false

  const state = (): HarnessV1ResumeSessionState => ({
    type: 'resume-session',
    harnessId: PI_HARNESS_ID,
    specificationVersion: 'harness-v1',
    data: { sessionId: piSession },
  })
  const stop = async () => {
    ended = true
    await running?.kill()
    running = undefined
  }

  return {
    sessionId: options.sessionId,
    isResume: options.resumeFrom !== undefined,
    async doPromptTurn(turn): Promise<HarnessV1PromptControl> {
      if (ended) throw new Error('This pi session has ended')
      if (turn.tools.length > 0) throw unsupported('host-executed tools')
      const n = ++turns
      await writeSkills({
        sandbox,
        homePath: home,
        skillsDir: PI_HOME_SKILLS_DIR,
        skills: turn.skills,
        ...(turn.abortSignal ? { abortSignal: turn.abortSignal } : {}),
      })
      await writeInstructions({
        sandbox,
        homePath: home,
        instructionsFile: PI_INSTRUCTIONS_FILE,
        ...(turn.instructions !== undefined ? { instructions: turn.instructions } : {}),
        ...(turn.abortSignal ? { abortSignal: turn.abortSignal } : {}),
      })
      const promptFile = posix.join(dataDir, `prompt-${n}.txt`)
      await sandbox.writeTextFile({
        path: promptFile,
        content: promptText(turn.prompt),
        abortSignal: turn.abortSignal,
      })
      if (gateway && !turn.model) {
        throw new Error(`pi on ${gateway.name} needs a model, the gateway's id for it`)
      }
      const before = turn.model ? writeModels(turn.model) : undefined
      const command = buildPiCommand({
        cli,
        workDir: sessionWorkDir,
        promptFile,
        model: turn.model,
        sessionId: piSession,
        sessionDir: posix.join(home, PI_AGENT_DIR, 'sessions'),
        mcp,
        ...(settings.effort ? { thinking: settings.effort } : {}),
        provider:
          turn.model && builtin(turn.model) ? (gateway?.catalog ?? provider.id) : provider.id,
        ...(before ? { before } : {}),
      })
      const translator = new PiStreamTranslator({
        mcpServers: Object.keys(settings.mcpServers ?? {}),
      })
      const emit = (parts: HarnessV1StreamPart[]) => {
        for (const part of parts) turn.emit(part)
      }
      const proc = await sandbox.spawn({
        command,
        workingDirectory: sessionWorkDir,
        env,
        ...(turn.abortSignal ? { abortSignal: turn.abortSignal } : {}),
      })
      running = proc
      const onAbort = () => void proc.kill()
      turn.abortSignal?.addEventListener('abort', onAbort, { once: true })
      const done = (async () => {
        const stderr = tail(proc.stderr).catch(() => '')
        try {
          for await (const line of lines(proc.stdout)) emit(translator.push(line))
          const { exitCode } = await proc.wait()
          emit(
            translator.end({
              exitCode,
              stderr: await stderr,
              aborted: turn.abortSignal?.aborted === true,
            }),
          )
        } finally {
          turn.abortSignal?.removeEventListener('abort', onAbort)
          if (running === proc) running = undefined
        }
      })()
      return {
        submitToolResult: () => Promise.reject(unsupported('host-executed tools')),
        done,
      }
    },
    doCompact: () => Promise.reject(unsupported('manual compaction')),
    doContinueTurn: () => Promise.reject(unsupported('turn continuation')),
    doSuspendTurn: () => Promise.reject(unsupported('turn suspension')),
    async doDetach() {
      await stop()
      return state()
    },
    async doStop() {
      await stop()
      return state()
    },
    doDestroy: stop,
  }
}
