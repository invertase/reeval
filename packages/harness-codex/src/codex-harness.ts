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
import { CodexStreamTranslator } from './codex-stream.ts'
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
 * `github.com`, the remote catalogue from `chatgpt.com`), which an eval doesn't use. The update
 * check is the TUI's, never `exec`'s; it's off in case that changes.
 */
export const CODEX_QUIET_CONFIG = {
  check_for_update_on_startup: false,
  analytics: { enabled: false },
  features: { plugins: false },
} as const

export type CodexHarnessSettings = {
  /** `{ OPENAI_API_KEY }`, the only key used. The host environment is never read. */
  readonly auth: HarnessV1AuthenticationEnvironment
  /** MCP servers in Codex's `[mcp_servers]` shape, keyed by name. */
  readonly mcpServers?: Record<string, Record<string, unknown>>
  /** Refuse a sandbox that can't broker the key, rather than forwarding the real one. */
  readonly requireCredentialBrokering?: boolean
}

const lifecycleData = z.object({ threadId: z.string().optional() })

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
 * Codex's `config.toml`: the quiet settings, reeval's provider as the model provider, and the MCP
 * servers. Each top-level key is one line, tables inline, so nothing depends on section order.
 */
export function buildCodexConfig(options: {
  mcpServers?: Record<string, Record<string, unknown>>
}): string {
  const config: Record<string, TomlValue> = {
    ...CODEX_QUIET_CONFIG,
    model_provider: CODEX_PROVIDER_ID,
    model_providers: {
      [CODEX_PROVIDER_ID]: {
        name: 'OpenAI',
        base_url: OPENAI_API_URL,
        env_key: CODEX_CREDENTIAL_ENV,
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
 * tokens, reasoning included. `@ai-sdk/harness-codex` reports neither those nor Codex's native
 * events, and needs a newer `@ai-sdk/harness` than reeval runs.
 */
export function createCodex(settings: CodexHarnessSettings): HarnessV1<CodexBuiltinTools> {
  const key = isHarnessAuthenticationEnvironment(settings.auth)
    ? settings.auth[CODEX_CREDENTIAL_ENV]
    : undefined
  if (!key) {
    throw new Error(
      `Codex auth must be an environment object with ${CODEX_CREDENTIAL_ENV} (an OpenAI API key)`,
    )
  }
  return {
    specificationVersion: 'harness-v1',
    harnessId: CODEX_HARNESS_ID,
    builtinTools: CODEX_BUILTIN_TOOLS,
    lifecycleStateSchema: lifecycleData,
    getBootstrap: getCodexBootstrap,
    doStart: (options) => startSession(settings, key, options),
  }
}

async function startSession(
  settings: CodexHarnessSettings,
  key: string,
  options: HarnessV1StartOptions,
): Promise<HarnessV1Session> {
  const { sandboxSession: sandbox, sessionWorkDir, abortSignal } = options
  let sandboxKey = key
  if (canBroker(sandbox)) {
    sandboxKey = generateSandboxCredentialPlaceholder()
    await sandbox.addRequestTransformations([
      createCredentialRequestTransformation({
        matchUrl: OPENAI_API_URL,
        matchHeaders: { Authorization: `Bearer ${sandboxKey}` },
        transformHeaders: { ...options.headers, Authorization: `Bearer ${key}` },
      }),
    ])
  } else if (settings.requireCredentialBrokering) {
    throw new Error(
      `The sandbox can't broker ${CODEX_CREDENTIAL_ENV} (it has no request transformations), and requireCredentialBrokering is set, so the key stays out of it.`,
    )
  }

  const home = await resolveSandboxHomeDir({ sandbox, abortSignal })
  const stateDir = harnessStateDirectoryPath({ sandboxHomeDir: home })
  const binDir = posix.join(stateDir, CODEX_BOOTSTRAP_DIR, CODEX_BIN_DIR)
  const dataDir = harnessSessionDataDirectoryPath({
    stateDirectory: stateDir,
    sessionId: options.sessionId,
  })
  await sandbox.writeTextFile({
    path: posix.join(home, CODEX_HOME_DIR, 'config.toml'),
    content: buildCodexConfig(settings.mcpServers ? { mcpServers: settings.mcpServers } : {}),
    abortSignal,
  })
  const resumed = lifecycleData.safeParse(options.resumeFrom?.data)
  let threadId = resumed.success ? resumed.data.threadId : undefined
  const env = { [CODEX_CREDENTIAL_ENV]: sandboxKey }
  let turns = 0
  let running: { kill(): PromiseLike<void> } | undefined
  let ended = false

  const state = (): HarnessV1ResumeSessionState => ({
    type: 'resume-session',
    harnessId: CODEX_HARNESS_ID,
    specificationVersion: 'harness-v1',
    data: threadId ? { threadId } : {},
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
      const translator = new CodexStreamTranslator({ workDir: sessionWorkDir })
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
