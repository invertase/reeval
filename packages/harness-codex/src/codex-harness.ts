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
import { CODEX_BIN_DIR, CODEX_BOOTSTRAP_DIR, getCodexBootstrap } from './codex-bootstrap.ts'
import { CodexStreamTranslator, type CodexUsage } from './codex-stream.ts'
import { CODEX_BUILTIN_TOOLS, type CodexBuiltinTools } from './codex-tools.ts'

export const CODEX_HARNESS_ID = 'codex'
/** The only credential the adapter uses: an OpenAI API key. */
export const CODEX_CREDENTIAL_ENV = 'OPENAI_API_KEY'
export const OPENAI_API_URL = 'https://api.openai.com/v1'
/** Codex's home under the sandbox home: its config, sessions and global rules. */
export const CODEX_HOME_DIR = '.codex'
/** Global rules, which Codex loads before the workspace's; `instructions` go here. */
export const CODEX_INSTRUCTIONS_FILE = `${CODEX_HOME_DIR}/AGENTS.md`
/** Where harness-placed skills go, under the sandbox home: Codex's user skill directory. */
export const CODEX_HOME_SKILLS_DIR = '.agents/skills'
/** The repo skill directory Codex reads, from the working directory up to the repo root. */
export const CODEX_WORKSPACE_SKILLS_DIR = '.agents/skills'
/** The provider the adapter gives Codex, so its requests are HTTP and it reads no login. */
export const CODEX_PROVIDER_ID = 'openai-http'

/** A Responses API Codex calls: its name, base URL, and the variable its key is in. */
export type CodexProvider = {
  readonly name: string
  readonly baseUrl: string
  readonly credentialEnv: string
}

/** OpenAI's API with an OpenAI API key: the default. */
export const OPENAI_PROVIDER: CodexProvider = {
  name: 'OpenAI',
  baseUrl: OPENAI_API_URL,
  credentialEnv: CODEX_CREDENTIAL_ENV,
}

/** Vercel AI Gateway's Responses API, whose model ids name their provider (`openai/…`). */
export const AI_GATEWAY_PROVIDER: CodexProvider = {
  name: 'Vercel AI Gateway',
  baseUrl: 'https://ai-gateway.vercel.sh/v1',
  credentialEnv: 'AI_GATEWAY_API_KEY',
}

/** OpenRouter's Responses API, whose model ids name their provider (`openai/…`). */
export const OPENROUTER_PROVIDER: CodexProvider = {
  name: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  credentialEnv: 'OPENROUTER_API_KEY',
}

/**
 * The one request Codex sends the key on, `POST /v1/responses`, on its own provider (with
 * WebSockets off, so it's always HTTP). A gateway that enforces it refuses the key anywhere else.
 */
export const CODEX_ENDPOINTS = [
  { host: new URL(OPENAI_API_URL).hostname, path: { exact: '/v1/responses' }, method: ['POST'] },
] as const

/**
 * Codex's defaults but for what it sends besides model requests: its analytics (to
 * `ab.chatgpt.com`), and the plugin sync (the curated list from
 * `github.com`, the remote catalogue from `chatgpt.com`), which an eval doesn't use. A session
 * given plugins turns plugins on, and with them the sync, which nothing else stops.
 */
export const CODEX_QUIET_CONFIG = {
  analytics: { enabled: false },
  features: { plugins: false },
} as const

/**
 * Codex's home marketplace, under the sandbox home, which lists the session's plugins. Each entry's
 * path is relative to the home directory.
 */
export const CODEX_MARKETPLACE_FILE = '.agents/plugins/marketplace.json'
/** The name of that marketplace, so a plugin is installed as `<plugin>@reeval`. */
export const CODEX_PLUGIN_MARKETPLACE = 'reeval'

/** A plugin directory in the sandbox (absolute, under its home), and the plugin's name. */
export type CodexPlugin = { readonly name: string; readonly dir: string }

export type CodexHarnessSettings = {
  /**
   * The provider's key under its `credentialEnv` (`{ OPENAI_API_KEY }` by default), the only key
   * used. The host environment is never read.
   */
  readonly auth: HarnessV1AuthenticationEnvironment
  /** The Responses API Codex calls; default OpenAI's. */
  readonly provider?: CodexProvider
  /** MCP servers in Codex's `[mcp_servers]` shape, keyed by name. */
  readonly mcpServers?: Record<string, Record<string, unknown>>
  /**
   * Plugins, in Claude Code's or Codex's plugin layout, which Codex reads either of: listed in its
   * home marketplace and installed with `codex plugin add` as the session starts, so Codex caches
   * a copy of each under `~/.codex/plugins/cache/` and loads its skills and MCP servers.
   */
  readonly plugins?: readonly CodexPlugin[]
  /** Refuse a sandbox that can't broker the key, rather than forwarding the real one. */
  readonly requireCredentialBrokering?: boolean
  /**
   * Reasoning effort as Codex's `model_reasoning_effort` (`low`, `medium`, `high`, `xhigh`,
   * `max`, `ultra`, …). Written into `config.toml`.
   */
  readonly effort?: string
}

const count = z.number().optional()
const lifecycleData = z.object({
  threadId: z.string().optional(),
  /** The thread's running total after its last completed turn, which the next turn's is less. */
  usage: z
    .object({
      input_tokens: count,
      cached_input_tokens: count,
      cache_write_input_tokens: count,
      output_tokens: count,
      reasoning_output_tokens: count,
    })
    .optional(),
})

const unsupported = (what: string) =>
  new HarnessCapabilityUnsupportedError({
    message: `codex exec has no ${what}`,
    harnessId: CODEX_HARNESS_ID,
  })

function promptText(prompt: HarnessV1Prompt): string {
  if (typeof prompt === 'string') return prompt
  const { content } = prompt
  if (typeof content === 'string') return content
  return content
    .map((part) => {
      if (part.type !== 'text') {
        throw new HarnessCapabilityUnsupportedError({
          message: `The Codex harness takes text prompts only (got a ${part.type} part)`,
          harnessId: CODEX_HARNESS_ID,
        })
      }
      return part.text
    })
    .join('\n')
}

type TomlValue = string | number | boolean | readonly TomlValue[] | { [key: string]: TomlValue }

/** A TOML inline value. JSON's strings are TOML basic strings; keys are always quoted. */
function toml(value: TomlValue): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value !== 'object') return String(value)
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`
  const entries = Object.entries(value as Record<string, TomlValue>)
  return `{ ${entries.map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`).join(', ')} }`
}

/**
 * Codex's `config.toml`: the quiet settings (plugins on when the session has some), reeval's
 * provider as the model provider, and the MCP servers. Each top-level key is one line, tables
 * inline, so nothing depends on section order and `codex plugin add` can append its tables.
 */
export function buildCodexConfig(options: {
  mcpServers?: Record<string, Record<string, unknown>>
  effort?: string
  plugins?: boolean
  provider?: CodexProvider
}): string {
  const provider = options.provider ?? OPENAI_PROVIDER
  const config: Record<string, TomlValue> = {
    ...CODEX_QUIET_CONFIG,
    ...(options.plugins ? { features: { ...CODEX_QUIET_CONFIG.features, plugins: true } } : {}),
    ...(options.effort ? { model_reasoning_effort: options.effort } : {}),
    model_provider: CODEX_PROVIDER_ID,
    model_providers: {
      [CODEX_PROVIDER_ID]: {
        name: provider.name,
        base_url: provider.baseUrl,
        env_key: provider.credentialEnv,
        wire_api: 'responses',
        supports_websockets: false,
      },
    },
    ...(options.mcpServers && Object.keys(options.mcpServers).length
      ? { mcp_servers: options.mcpServers as Record<string, TomlValue> }
      : {}),
  }
  return `${Object.entries(config)
    .map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`)
    .join('\n')}\n`
}

/** The home marketplace listing the plugins, each by its path relative to `home`. */
export function buildCodexMarketplace(plugins: readonly CodexPlugin[], home: string): string {
  const entries = plugins.map((p) => {
    const path = posix.relative(home, p.dir)
    if (!path || path.startsWith('..') || posix.isAbsolute(path)) {
      throw new Error(
        `Codex lists plugins in its home marketplace, so the ${p.name} plugin must be under ${home} (it's at ${p.dir})`,
      )
    }
    return { name: p.name, source: { source: 'local', path: `./${path}` } }
  })
  return `${JSON.stringify({ name: CODEX_PLUGIN_MARKETPLACE, plugins: entries }, null, 2)}\n`
}

/** `codex plugin add <plugin>@reeval` for each plugin, offline from the home marketplace. */
export function buildCodexPluginAdd(binDir: string, plugins: readonly CodexPlugin[]): string {
  return plugins
    .map(
      (p) =>
        `PATH=${shellQuote(binDir)}:"$PATH" codex plugin add ${shellQuote(`${p.name}@${CODEX_PLUGIN_MARKETPLACE}`)} < /dev/null`,
    )
    .join(' && ')
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
 * The Codex turn command: `codex exec --json`, no approvals or Codex sandbox (the sandbox is the
 * isolation), outside a git repo if need be, resuming the thread after the first turn. stdin is
 * closed, or Codex waits to append it to the prompt. The prompt is an argument, so it must stay
 * under the shell's 128 KiB.
 */
export function buildCodexCommand(options: {
  binDir: string
  workDir: string
  promptFile: string
  model: string | undefined
  threadId: string | undefined
}): string {
  return [
    `cd ${shellQuote(options.workDir)} &&`,
    `PATH=${shellQuote(options.binDir)}:"$PATH" exec codex exec --json`,
    '--skip-git-repo-check --dangerously-bypass-approvals-and-sandbox',
    ...(options.model ? [`--model ${shellQuote(options.model)}`] : []),
    ...(options.threadId ? [`resume ${shellQuote(options.threadId)}`] : []),
    `-- "$(cat ${shellQuote(options.promptFile)})" < /dev/null`,
  ].join(' ')
}

/**
 * OpenAI's Codex CLI (`codex exec --json`) as an AI SDK harness, in the sandbox: one process per
 * turn, resumed by thread id, its NDJSON translated into harness stream parts with each turn's
 * tokens, reasoning included. `@ai-sdk/harness-codex` needs a newer `@ai-sdk/harness` than
 * reeval runs.
 */
export function createCodex(settings: CodexHarnessSettings): HarnessV1<CodexBuiltinTools> {
  const provider = settings.provider ?? OPENAI_PROVIDER
  const key = isHarnessAuthenticationEnvironment(settings.auth)
    ? settings.auth[provider.credentialEnv]
    : undefined
  if (!key) {
    throw new Error(
      `Codex auth must be an environment object with ${provider.credentialEnv} (${/^[AEIOU]/.test(provider.name) ? 'an' : 'a'} ${provider.name} key)`,
    )
  }
  return {
    specificationVersion: 'harness-v1',
    harnessId: CODEX_HARNESS_ID,
    builtinTools: CODEX_BUILTIN_TOOLS,
    lifecycleStateSchema: lifecycleData,
    getBootstrap: getCodexBootstrap,
    doStart: (options) => startSession(settings, provider, key, options),
  }
}

async function startSession(
  settings: CodexHarnessSettings,
  provider: CodexProvider,
  key: string,
  options: HarnessV1StartOptions,
): Promise<HarnessV1Session> {
  const { sandboxSession: sandbox, sessionWorkDir, abortSignal } = options
  let sandboxKey = key
  if (canBroker(sandbox)) {
    sandboxKey = generateSandboxCredentialPlaceholder()
    await sandbox.addRequestTransformations([
      createCredentialRequestTransformation({
        matchUrl: provider.baseUrl,
        matchHeaders: { Authorization: `Bearer ${sandboxKey}` },
        transformHeaders: { ...options.headers, Authorization: `Bearer ${key}` },
      }),
    ])
  } else if (settings.requireCredentialBrokering) {
    throw new Error(
      `The sandbox can't broker ${provider.credentialEnv} (it has no request transformations), and requireCredentialBrokering is set, so the key stays out of it.`,
    )
  }

  const home = await resolveSandboxHomeDir({ sandbox, abortSignal })
  const stateDir = harnessStateDirectoryPath({ sandboxHomeDir: home })
  const binDir = posix.join(stateDir, CODEX_BOOTSTRAP_DIR, CODEX_BIN_DIR)
  const dataDir = harnessSessionDataDirectoryPath({
    stateDirectory: stateDir,
    sessionId: options.sessionId,
  })
  const plugins = settings.plugins ?? []
  await sandbox.writeTextFile({
    path: posix.join(home, CODEX_HOME_DIR, 'config.toml'),
    content: buildCodexConfig({
      ...(settings.mcpServers ? { mcpServers: settings.mcpServers } : {}),
      ...(settings.effort ? { effort: settings.effort } : {}),
      ...(plugins.length ? { plugins: true } : {}),
      provider,
    }),
    abortSignal,
  })
  if (plugins.length) {
    await sandbox.writeTextFile({
      path: posix.join(home, CODEX_MARKETPLACE_FILE),
      content: buildCodexMarketplace(plugins, home),
      abortSignal,
    })
    const added = await sandbox.run({ command: buildCodexPluginAdd(binDir, plugins), abortSignal })
    if (added.exitCode !== 0) {
      throw new Error(
        `codex plugin add failed (exit ${added.exitCode}): ${(added.stderr || added.stdout).trim().slice(-2000)}`,
      )
    }
  }
  const resumed = lifecycleData.safeParse(options.resumeFrom?.data)
  let threadId = resumed.success ? resumed.data.threadId : undefined
  let threadUsage: CodexUsage | undefined = resumed.success ? resumed.data.usage : undefined
  const env = { [provider.credentialEnv]: sandboxKey }
  let turns = 0
  let running: { kill(): PromiseLike<void> } | undefined
  let ended = false

  const state = (): HarnessV1ResumeSessionState => ({
    type: 'resume-session',
    harnessId: CODEX_HARNESS_ID,
    specificationVersion: 'harness-v1',
    data: {
      ...(threadId ? { threadId } : {}),
      ...(threadId && threadUsage ? { usage: threadUsage } : {}),
    },
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
      if (ended) throw new Error('This Codex session has ended')
      if (turn.tools.length > 0) throw unsupported('host-executed tools')
      const n = ++turns
      await writeSkills({
        sandbox,
        homePath: home,
        skillsDir: CODEX_HOME_SKILLS_DIR,
        skills: turn.skills,
        ...(turn.abortSignal ? { abortSignal: turn.abortSignal } : {}),
      })
      await writeInstructions({
        sandbox,
        homePath: home,
        instructionsFile: CODEX_INSTRUCTIONS_FILE,
        ...(turn.instructions !== undefined ? { instructions: turn.instructions } : {}),
        ...(turn.abortSignal ? { abortSignal: turn.abortSignal } : {}),
      })
      const promptFile = posix.join(dataDir, `prompt-${n}.txt`)
      await sandbox.writeTextFile({
        path: promptFile,
        content: promptText(turn.prompt),
        abortSignal: turn.abortSignal,
      })
      const command = buildCodexCommand({
        binDir,
        workDir: sessionWorkDir,
        promptFile,
        model: turn.model,
        threadId,
      })
      const translator = new CodexStreamTranslator({ workDir: sessionWorkDir, threadUsage })
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
          threadId = translator.threadId ?? threadId
          threadUsage = translator.threadUsage
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
