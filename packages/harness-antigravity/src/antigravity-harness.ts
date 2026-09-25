import { posix } from 'node:path'
import {
  HarnessCapabilityUnsupportedError,
  type HarnessV1,
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
  generateSandboxCredentialPlaceholder,
  resolveSandboxHomeDir,
  writeInstructions,
  writeSkills,
} from '@ai-sdk/harness/utils'
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils'
import { z } from 'zod'
import {
  ANTIGRAVITY_BASE_URL_ENV,
  ANTIGRAVITY_CREDENTIAL_ENV,
  type AntigravityAuthentication,
  createAntigravityRequestTransformations,
  resolveAntigravityCredentials,
} from './antigravity-auth.ts'
import {
  ANTIGRAVITY_BOOTSTRAP_DIR,
  ANTIGRAVITY_CLI_PATH,
  getAntigravityBootstrap,
} from './antigravity-bootstrap.ts'
import { type AntigravityEffort, buildAntigravityCommand } from './antigravity-command.ts'
import { AntigravityStreamTranslator } from './antigravity-stream.ts'
import { ANTIGRAVITY_BUILTIN_TOOLS, type AntigravityBuiltinTools } from './antigravity-tools.ts'

export const ANTIGRAVITY_HARNESS_ID = 'antigravity'

/** Where the CLI reads home skills (1.2.11; its docs' `~/.gemini/antigravity-cli/skills` isn't read). */
export const ANTIGRAVITY_HOME_SKILLS_DIR = '.gemini/config/skills'
/** Always-on global rules; `instructions` are appended here. */
export const ANTIGRAVITY_INSTRUCTIONS_FILE = '.gemini/GEMINI.md'
export const ANTIGRAVITY_MCP_CONFIG_FILE = '.gemini/config/mcp_config.json'
export const ANTIGRAVITY_SETTINGS_FILE = '.gemini/antigravity-cli/settings.json'
/** Where the CLI reads workspace rules and skills, relative to the workspace. */
export const ANTIGRAVITY_WORKSPACE_RULES_FILE = 'AGENTS.md'
export const ANTIGRAVITY_WORKSPACE_SKILLS_DIR = '.agents/skills'

export type AntigravityHarnessSettings = {
  /** Defaults to `'auto'`: `GEMINI_API_KEY` from the host. See {@link AntigravityAuthentication}. */
  readonly auth?: AntigravityAuthentication
  /**
   * Refuse to start rather than put the real key in the sandbox when the sandbox can't broker
   * it (has no `addRequestTransformations`). By default the adapter warns and forwards the key,
   * as the AI SDK's adapters do.
   */
  readonly requireCredentialBrokering?: boolean
  /** Reasoning effort, for models that take one (`--effort`). */
  readonly effort?: AntigravityEffort
  /** MCP servers in the CLI's `mcp_config.json` shape (`command`/`args`/`env` or `serverUrl`/`headers`). */
  readonly mcpServers?: Record<string, unknown>
  /** Extra keys for the CLI's `settings.json`. `modelProvider` is always `gemini`. */
  readonly settings?: Record<string, unknown>
  /** Extra variables for the CLI process. */
  readonly env?: Record<string, string>
}

const lifecycleData = z.object({ conversationId: z.string().nullable() })

function promptText(prompt: HarnessV1Prompt): string {
  if (typeof prompt === 'string') return prompt
  const { content } = prompt
  if (typeof content === 'string') return content
  return content
    .map((part) => {
      if (part.type !== 'text') {
        throw new HarnessCapabilityUnsupportedError({
          message: `The Antigravity CLI takes text prompts only (got a ${part.type} part)`,
          harnessId: ANTIGRAVITY_HARNESS_ID,
        })
      }
      return part.text
    })
    .join('\n')
}

const unsupported = (what: string) =>
  new HarnessCapabilityUnsupportedError({
    message: `The Antigravity CLI's print mode has no ${what}`,
    harnessId: ANTIGRAVITY_HARNESS_ID,
  })

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      yield buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  }
  buffer += decoder.decode()
  if (buffer) yield buffer
}

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
 * The Antigravity CLI (`agy`) as an AI SDK harness. It has no ACP mode, so each turn is one
 * `agy -p … --output-format stream-json` process, resumed with `--conversation`, and its NDJSON
 * is translated into harness stream parts. Only a Gemini API key authenticates it.
 */
export function createAntigravity(
  settings: AntigravityHarnessSettings = {},
): HarnessV1<AntigravityBuiltinTools> {
  return {
    specificationVersion: 'harness-v1',
    harnessId: ANTIGRAVITY_HARNESS_ID,
    builtinTools: ANTIGRAVITY_BUILTIN_TOOLS,
    lifecycleStateSchema: lifecycleData,
    getBootstrap: getAntigravityBootstrap,
    doStart: (options) => startSession(settings, options),
  }
}

async function startSession(
  settings: AntigravityHarnessSettings,
  options: HarnessV1StartOptions,
): Promise<HarnessV1Session> {
  const { sandboxSession: sandbox, sessionWorkDir, sessionId, abortSignal } = options
  const credentials = resolveAntigravityCredentials(settings.auth)

  let sandboxKey = credentials.apiKey
  if (canBroker(sandbox)) {
    sandboxKey = generateSandboxCredentialPlaceholder()
    await sandbox.addRequestTransformations(
      createAntigravityRequestTransformations({
        credentials,
        placeholder: sandboxKey,
        ...(options.headers ? { headers: options.headers } : {}),
      }),
    )
  } else if (settings.requireCredentialBrokering) {
    throw new Error(
      `The sandbox can't broker ${ANTIGRAVITY_CREDENTIAL_ENV} (it has no request transformations), and requireCredentialBrokering is set, so the key stays out of it.`,
    )
  } else {
    console.warn(
      'The sandbox implementation does not support configuring request transformations, so credential brokering does not work. Falling back to less secure credential forwarding.',
    )
  }

  const home = await resolveSandboxHomeDir({ sandbox, abortSignal })
  const stateDir = harnessStateDirectoryPath({ sandboxHomeDir: home })
  const cli = posix.join(stateDir, ANTIGRAVITY_BOOTSTRAP_DIR, ANTIGRAVITY_CLI_PATH)
  const sessionDir = harnessSessionDataDirectoryPath({ stateDirectory: stateDir, sessionId })
  const write = (file: string, content: string) =>
    sandbox.writeTextFile({ path: posix.join(home, file), content, abortSignal })
  await write(
    ANTIGRAVITY_SETTINGS_FILE,
    `${JSON.stringify({ ...settings.settings, modelProvider: 'gemini' }, null, 2)}\n`,
  )
  if (settings.mcpServers && Object.keys(settings.mcpServers).length > 0) {
    await write(
      ANTIGRAVITY_MCP_CONFIG_FILE,
      `${JSON.stringify({ mcpServers: settings.mcpServers }, null, 2)}\n`,
    )
  }

  const env: Record<string, string> = {
    ...settings.env,
    [ANTIGRAVITY_CREDENTIAL_ENV]: sandboxKey,
    AGY_CLI_DISABLE_AUTO_UPDATE: '1',
    ...(credentials.baseUrl ? { [ANTIGRAVITY_BASE_URL_ENV]: credentials.baseUrl } : {}),
  }

  const resumed = lifecycleData.safeParse(options.resumeFrom?.data)
  let conversationId = resumed.success ? resumed.data.conversationId : null
  let turns = 0
  let running: { kill(): PromiseLike<void> } | undefined
  let ended = false

  const state = (): HarnessV1ResumeSessionState => ({
    type: 'resume-session',
    harnessId: ANTIGRAVITY_HARNESS_ID,
    specificationVersion: 'harness-v1',
    data: { conversationId },
  })
  const stop = async () => {
    ended = true
    await running?.kill()
    running = undefined
  }

  return {
    sessionId,
    isResume: options.resumeFrom !== undefined,
    async doPromptTurn(turn): Promise<HarnessV1PromptControl> {
      if (ended) throw new Error('This Antigravity session has ended')
      if (turn.tools.length > 0) throw unsupported('host-executed tools')
      const n = ++turns
      await writeSkills({
        sandbox,
        homePath: home,
        skillsDir: ANTIGRAVITY_HOME_SKILLS_DIR,
        skills: turn.skills,
        ...(turn.abortSignal ? { abortSignal: turn.abortSignal } : {}),
      })
      await writeInstructions({
        sandbox,
        homePath: home,
        instructionsFile: ANTIGRAVITY_INSTRUCTIONS_FILE,
        ...(turn.instructions !== undefined ? { instructions: turn.instructions } : {}),
        ...(turn.abortSignal ? { abortSignal: turn.abortSignal } : {}),
      })
      const promptFile = posix.join(sessionDir, `prompt-${n}.txt`)
      await sandbox.writeTextFile({ path: promptFile, content: promptText(turn.prompt) })
      let jsonSchemaFile: string | undefined
      if (turn.responseFormat?.type === 'json' && turn.responseFormat.schema) {
        jsonSchemaFile = posix.join(sessionDir, `schema-${n}.json`)
        await sandbox.writeTextFile({
          path: jsonSchemaFile,
          content: JSON.stringify(turn.responseFormat.schema),
        })
      }
      const command = buildAntigravityCommand({
        cli,
        workDir: sessionWorkDir,
        promptFile,
        model: turn.model,
        effort: settings.effort,
        permissionMode: options.permissionMode,
        conversationId: conversationId ?? undefined,
        jsonSchemaFile,
      })
      const translator = new AntigravityStreamTranslator({
        turn: n,
        conversationId: conversationId ?? undefined,
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
        const stderr = tail(proc.stderr)
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
          conversationId = translator.conversationId ?? conversationId
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
