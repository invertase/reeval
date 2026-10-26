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
import { PiStreamTranslator } from './pi-stream.ts'
import { PI_BUILTIN_TOOLS, type PiBuiltinTools } from './pi-tools.ts'

export const PI_HARNESS_ID = 'pi'
/** The only credential the adapter uses: a Gemini API key, for pi's `google` provider. */
export const PI_CREDENTIAL_ENV = 'GEMINI_API_KEY'
export const GEMINI_API_URL = 'https://generativelanguage.googleapis.com'
/** The header pi's `google` provider sends the key in. */
export const GEMINI_API_KEY_HEADER = 'x-goog-api-key'
/** pi's agent directory under the home: its sessions, settings, global skills and rules. */
/** pi's provider for Vertex AI, which authenticates from Application Default Credentials. */
export const PI_VERTEX_PROVIDER = 'google-vertex'
export const PI_AGENT_DIR = '.pi/agent'
/** Where harness-placed skills go, under the sandbox home. */
export const PI_HOME_SKILLS_DIR = `${PI_AGENT_DIR}/skills`
/** Global rules, which pi loads before the workspace's; `instructions` go here. */
export const PI_INSTRUCTIONS_FILE = `${PI_AGENT_DIR}/AGENTS.md`
/** The repo skill directory pi reads when the project is trusted (`--approve`). */
export const PI_WORKSPACE_SKILLS_DIR = '.pi/skills'
/** pi's global MCP config, which its built-in `mcp` extension reads. */
export const PI_MCP_FILE = `${PI_AGENT_DIR}/mcp.json`

/**
 * The model-request endpoint pi sends the key on, `POST /v1beta/models/<model>:
 * streamGenerateContent`. A gateway that enforces it refuses the key
 * anywhere else.
 */
export const PI_ENDPOINTS = [
  {
    host: new URL(GEMINI_API_URL).hostname,
    path: { regex: '^/v1beta/models/[^/]+:streamGenerateContent$' },
    method: ['POST'],
  },
] as const

/** pi's model list, which a {@link PiGateway}'s provider goes in. */
export const PI_MODELS_FILE = `${PI_AGENT_DIR}/models.json`

/**
 * An AI gateway pi reaches a Gemini model through, as a pi provider on the gateway's OpenAI-compatible
 * Chat Completions API: the key, sent as a Bearer token, and the `providerOptions` keys its
 * native Gemini `thinkingConfig` goes under.
 */
export type PiGateway = {
  /** For messages: `Vercel AI Gateway`. */
  readonly name: string
  /** The pi provider id, `--provider`. */
  readonly id: string
  readonly credentialEnv: string
  /** The Chat Completions base URL, ending `/v1`. */
  readonly baseUrl: string
  readonly upstreams: readonly string[]
}

/**
 * Vercel AI Gateway, whose model ids name their provider (`google/gemini-3.8-flash`). It takes
 * Gemini's own `thinkingConfig` under the provider that serves the call, Google's or Vertex's.
 */
export const PI_AI_GATEWAY: PiGateway = {
  name: 'Vercel AI Gateway',
  id: 'reeval-ai-gateway',
  credentialEnv: 'AI_GATEWAY_API_KEY',
  baseUrl: 'https://ai-gateway.vercel.sh/v1',
  upstreams: ['google', 'vertex'],
}

/** The model call pi makes on a {@link PiGateway}: Chat Completions, which it streams. */
export const piGatewayEndpoints = (gateway: PiGateway) =>
  [
    {
      host: new URL(gateway.baseUrl).hostname,
      path: { exact: `${new URL(gateway.baseUrl).pathname}/chat/completions` },
      method: ['POST'],
    },
  ] as const

/** An `mcp.json` server: stdio (`command`) or streamable HTTP (`url`); pi has no SSE transport. */
export type PiMcpServer =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { url: string; headers?: Record<string, string> }

export type PiHarnessSettings = {
  /**
   * `{ GEMINI_API_KEY }`, or the gateway's key under its `credentialEnv`: the only key used. The
   * host environment is never read.
   */
  readonly auth: HarnessV1AuthenticationEnvironment
  /**
   * Run the model on this gateway rather than Gemini's API: a model is the gateway's id
   * (`google/gemini-3.8-flash`) of a Gemini model in pi's catalog that takes a thinking level.
   */
  readonly gateway?: PiGateway
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
  /** The pi provider, `google` by default. */
  provider?: string
  /** A command that must succeed before pi starts, such as writing its models.json. */
  before?: string
}): string {
  return [
    `cd ${shellQuote(options.workDir)} &&`,
    ...(options.before ? [`${options.before} &&`] : []),
    `exec ${shellQuote(options.cli)} --mode json -p --offline --approve --no-extensions`,
    ...(options.mcp ? ['-e builtin:mcp'] : []),
    `--provider ${shellQuote(options.provider ?? 'google')}`,
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
  const credential = settings.gateway?.credentialEnv ?? PI_CREDENTIAL_ENV
  const key = isHarnessAuthenticationEnvironment(settings.auth)
    ? settings.auth[credential]
    : undefined
  if (!key && !settings.vertex) {
    throw new Error(
      `pi auth must be an environment object with ${credential} (${settings.gateway ? `a ${settings.gateway.name} key` : 'a Gemini API key'})`,
    )
  }
  return {
    specificationVersion: 'harness-v1',
    harnessId: PI_HARNESS_ID,
    builtinTools: PI_BUILTIN_TOOLS,
    lifecycleStateSchema: lifecycleData,
    getBootstrap: getPiBootstrap,
    doStart: (options) => startSession(settings, key, options),
  }
}

async function startSession(
  settings: PiHarnessSettings,
  key: string | undefined,
  options: HarnessV1StartOptions,
): Promise<HarnessV1Session> {
  const { sandboxSession: sandbox, sessionWorkDir, abortSignal } = options
  const { gateway, vertex } = settings
  const credential = gateway?.credentialEnv ?? PI_CREDENTIAL_ENV
  const header = gateway ? 'Authorization' : GEMINI_API_KEY_HEADER
  const sent = (value: string) => (gateway ? `Bearer ${value}` : value)
  let sandboxKey = key
  if (!key || vertex) {
    sandboxKey = undefined
  } else if (canBroker(sandbox)) {
    sandboxKey = generateSandboxCredentialPlaceholder()
    await sandbox.addRequestTransformations([
      createCredentialRequestTransformation({
        matchUrl: gateway ? new URL(gateway.baseUrl).origin : GEMINI_API_URL,
        matchHeaders: { [header]: sent(sandboxKey) },
        transformHeaders: { ...options.headers, [header]: sent(key) },
      }),
    ])
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
  const writeModels = (model: string) =>
    gateway
      ? [
          'node',
          ...[modelsScript, bootstrapDir, posix.join(home, PI_MODELS_FILE)],
          ...[JSON.stringify(gateway), model],
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
        ...(vertex ? { provider: PI_VERTEX_PROVIDER } : {}),
        ...(gateway ? { provider: gateway.id } : {}),
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
