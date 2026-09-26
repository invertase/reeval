import { posix } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
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
  shellQuote,
  warnCredentialBrokeringUnavailable,
  writeSkills,
} from '@ai-sdk/harness/utils'
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils'
import { z } from 'zod'
import {
  CURSOR_SDK_CREDENTIAL_ENV,
  CURSOR_SDK_MODEL_CATALOG_ENV,
  type CursorSdkAuthentication,
  type CursorSdkModelEntry,
  catalogFor,
  createCursorSdkRequestTransformations,
  fetchCursorModelCatalog,
  resolveCursorSdkCredentials,
} from './cursor-sdk-auth.ts'
import {
  CURSOR_SDK_BOOTSTRAP_DIR,
  CURSOR_SDK_RUNNER_PATH,
  CURSOR_SDK_VERSION,
  cursorSdkTurnReady,
  getCursorSdkBootstrap,
} from './cursor-sdk-bootstrap.ts'
import { type CursorSdkModel, CursorSdkStreamTranslator } from './cursor-sdk-stream.ts'
import { CURSOR_SDK_BUILTIN_TOOLS, type CursorSdkBuiltinTools } from './cursor-sdk-tools.ts'

export const CURSOR_SDK_HARNESS_ID = 'cursor-sdk'

/** Where harness-placed skills go, under `~/` (the SDK's `user` layer reads `~/.agents/skills`). */
export const CURSOR_SDK_HOME_SKILLS_DIR = '.agents/skills'
/** Where the SDK reads workspace rules and skills, relative to the workspace. */
export const CURSOR_SDK_WORKSPACE_RULES_FILE = 'AGENTS.md'
export const CURSOR_SDK_WORKSPACE_SKILLS_DIR = '.cursor/skills'

export type CursorSdkSettingSource = 'project' | 'user' | 'team' | 'mdm' | 'plugins' | 'all'

export type CursorSdkHarnessSettings = {
  /** Defaults to `'auto'`: `CURSOR_API_KEY` from the host. */
  readonly auth?: CursorSdkAuthentication
  /**
   * Refuse to start rather than put the real key in the sandbox when the sandbox can't broker
   * it (has no `addRequestTransformations`). By default the adapter warns and forwards the key,
   * as the AI SDK's adapters do.
   */
  readonly requireCredentialBrokering?: boolean
  /**
   * Model parameters, e.g. `{ fast: 'false' }` for `composer-2.5`. Parameters left unset take the
   * catalog's default variant (`isDefault`; `composer-2.5` is `fast=true`), which the adapter
   * passes explicitly, so the turn asks for exactly what it records.
   */
  readonly modelParams?: Readonly<Record<string, string>>
  /**
   * The model catalog the SDK validates the model against. `'fetch'` (the default) gets it on
   * the host with the real key, so the sandbox never calls `api.cursor.com`; `false` lets the
   * SDK fetch it itself (with the sandbox's key).
   */
  readonly modelCatalog?: 'fetch' | false | readonly CursorSdkModelEntry[]
  /** On-disk layers the agent loads. Defaults to `project` and `user` (rules, skills, MCP, hooks). */
  readonly settingSources?: readonly CursorSdkSettingSource[]
  /** MCP servers in the SDK's `McpServerConfig` shape, passed inline on every turn. */
  readonly mcpServers?: Record<string, unknown>
  /** The SDK's own shell sandbox (bubblewrap on Linux). Off: ES's container is the boundary. */
  readonly sdkSandbox?: boolean
  /** Extra variables for the runner process. */
  readonly env?: Record<string, string>
}

const lifecycleData = z.object({ agentId: z.string().nullable() })

function promptText(prompt: HarnessV1Prompt, instructions: string | undefined): string {
  const content = typeof prompt === 'string' ? prompt : prompt.content
  const text =
    typeof content === 'string'
      ? content
      : content
          .map((part) => {
            if (part.type !== 'text') {
              throw new HarnessCapabilityUnsupportedError({
                message: `The Cursor SDK adapter takes text prompts only (got a ${part.type} part)`,
                harnessId: CURSOR_SDK_HARNESS_ID,
              })
            }
            return part.text
          })
          .join('\n')
  if (!instructions) return text
  // The same guidance block the AI SDK's ACP adapters prepend.
  return [
    '<session-guidance>',
    'This block is operating guidance from the harness, not user-authored content.',
    '<instructions>',
    instructions,
    '</instructions>',
    '</session-guidance>',
    text,
  ].join('\n')
}

const unsupported = (what: string) =>
  new HarnessCapabilityUnsupportedError({
    message: `The Cursor SDK adapter has no ${what}`,
    harnessId: CURSOR_SDK_HARNESS_ID,
  })

const lines = (stream: ReadableStream<Uint8Array>) =>
  createInterface({ input: Readable.fromWeb(stream as WebReadableStream), crlfDelay: Infinity })

/** The runner process, its stdout as lines across turns, and the end of its stderr. */
type Runner = {
  proc: { kill(): PromiseLike<void>; wait(): PromiseLike<{ exitCode: number }> }
  stdout: AsyncIterator<string>
  stderr: () => Promise<string>
  exited: boolean
}

function startRunner(proc: {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  kill(): PromiseLike<void>
  wait(): PromiseLike<{ exitCode: number }>
}): Runner {
  let stderr = ''
  const drained = (async () => {
    for await (const line of lines(proc.stderr)) stderr = `${stderr}${line}\n`.slice(-4000)
  })().catch(() => {})
  const runner: Runner = {
    proc,
    stdout: lines(proc.stdout)[Symbol.asyncIterator](),
    // Once it has exited, what it wrote last; a stream that never closes doesn't hold the turn.
    stderr: async () => {
      await Promise.race([drained, new Promise((r) => setTimeout(r, 1000).unref())])
      return stderr
    },
    exited: false,
  }
  Promise.resolve(proc.wait()).then(
    () => (runner.exited = true),
    () => (runner.exited = true),
  )
  return runner
}

const canBroker = (
  sandbox: HarnessV1NetworkSandboxSession | SandboxSession,
): sandbox is HarnessV1NetworkSandboxSession &
  Required<Pick<HarnessV1NetworkSandboxSession, 'addRequestTransformations'>> =>
  'addRequestTransformations' in sandbox && typeof sandbox.addRequestTransformations === 'function'

/**
 * Cursor's agent through the Cursor TypeScript SDK's local runtime, as an AI SDK harness. The
 * agent loop runs in a Node process in the sandbox that lives across the session's turns (a new
 * one resumes the agent by id from a JSONL store), so its tools act on the sandbox's files;
 * inference is Cursor's hosted models. The SDK reports token usage for every turn.
 */
export function createCursorSdk(
  settings: CursorSdkHarnessSettings = {},
): HarnessV1<CursorSdkBuiltinTools> {
  return {
    specificationVersion: 'harness-v1',
    harnessId: CURSOR_SDK_HARNESS_ID,
    builtinTools: CURSOR_SDK_BUILTIN_TOOLS,
    lifecycleStateSchema: lifecycleData,
    getBootstrap: getCursorSdkBootstrap,
    doStart: (options) => startSession(settings, options),
  }
}

async function startSession(
  settings: CursorSdkHarnessSettings,
  options: HarnessV1StartOptions,
): Promise<HarnessV1Session> {
  const { sandboxSession: sandbox, sessionWorkDir, sessionId, abortSignal } = options
  const credentials = resolveCursorSdkCredentials(settings.auth)

  let sandboxKey = credentials.apiKey
  if (canBroker(sandbox)) {
    sandboxKey = generateSandboxCredentialPlaceholder()
    await sandbox.addRequestTransformations(
      createCursorSdkRequestTransformations({
        credentials,
        placeholder: sandboxKey,
        ...(options.headers ? { headers: options.headers } : {}),
      }),
    )
  } else if (settings.requireCredentialBrokering) {
    throw new Error(
      `The sandbox can't broker ${CURSOR_SDK_CREDENTIAL_ENV} (it has no request transformations), and requireCredentialBrokering is set, so the key stays out of it.`,
    )
  } else {
    warnCredentialBrokeringUnavailable({
      environment: { [CURSOR_SDK_CREDENTIAL_ENV]: credentials.apiKey },
      forwardedEnvironment: { [CURSOR_SDK_CREDENTIAL_ENV]: sandboxKey },
      credentialEnvironmentVariables: [CURSOR_SDK_CREDENTIAL_ENV],
    })
  }

  const catalogSetting = settings.modelCatalog ?? 'fetch'
  const catalog =
    catalogSetting === 'fetch'
      ? await fetchCursorModelCatalog(credentials, abortSignal ? { signal: abortSignal } : {})
      : catalogSetting === false
        ? undefined
        : [...catalogSetting]

  const home = await resolveSandboxHomeDir({ sandbox, abortSignal })
  const stateDir = harnessStateDirectoryPath({ sandboxHomeDir: home })
  const runnerPath = posix.join(stateDir, CURSOR_SDK_BOOTSTRAP_DIR, CURSOR_SDK_RUNNER_PATH)
  const sessionDir = harnessSessionDataDirectoryPath({ stateDirectory: stateDir, sessionId })
  const storeDir = posix.join(sessionDir, 'agent-store')

  const resumed = lifecycleData.safeParse(options.resumeFrom?.data)
  let agentId = resumed.success ? resumed.data.agentId : null
  let turns = 0
  let runner: Runner | undefined
  let ended = false

  const state = (): HarnessV1ResumeSessionState => ({
    type: 'resume-session',
    harnessId: CURSOR_SDK_HARNESS_ID,
    specificationVersion: 'harness-v1',
    data: { agentId },
  })
  const stopRunner = async () => {
    const r = runner
    runner = undefined
    await r?.proc.kill()
  }
  const stop = async () => {
    ended = true
    await stopRunner()
  }

  return {
    sessionId,
    isResume: options.resumeFrom !== undefined,
    async doPromptTurn(turn): Promise<HarnessV1PromptControl> {
      if (ended) throw new Error('This Cursor SDK session has ended')
      if (turn.tools.length > 0) throw unsupported('host-executed tools')
      if (turn.responseFormat?.type === 'json') throw unsupported('structured output')
      const n = ++turns
      await writeSkills({
        sandbox,
        homePath: home,
        skillsDir: CURSOR_SDK_HOME_SKILLS_DIR,
        skills: turn.skills,
        ...(turn.abortSignal ? { abortSignal: turn.abortSignal } : {}),
      })
      const promptFile = posix.join(sessionDir, `prompt-${n}.txt`)
      await sandbox.writeTextFile({
        path: promptFile,
        content: promptText(turn.prompt, turn.instructions),
        abortSignal: turn.abortSignal,
      })
      const model: CursorSdkModel | undefined = turn.model
        ? withParams(turn.model, settings.modelParams, catalog)
        : undefined
      const turnFile = posix.join(sessionDir, `turn-${n}.json`)
      await sandbox.writeTextFile({
        path: turnFile,
        content: JSON.stringify({
          cwd: sessionWorkDir,
          storeDir,
          promptFile,
          agentId: agentId ?? undefined,
          model,
          settingSources: settings.settingSources ?? ['project', 'user'],
          sandbox: settings.sdkSandbox === true,
          sdkVersion: CURSOR_SDK_VERSION,
          ...(settings.mcpServers && Object.keys(settings.mcpServers).length > 0
            ? { mcpServers: settings.mcpServers }
            : {}),
        }),
        abortSignal: turn.abortSignal,
      })
      await sandbox.writeTextFile({
        path: posix.join(sessionDir, cursorSdkTurnReady(n)),
        content: '',
        abortSignal: turn.abortSignal,
      })
      if (runner?.exited) runner = undefined
      if (!runner) {
        const env: Record<string, string> = {
          ...settings.env,
          [CURSOR_SDK_CREDENTIAL_ENV]: sandboxKey,
          ...(catalog
            ? { [CURSOR_SDK_MODEL_CATALOG_ENV]: JSON.stringify(catalogFor(catalog, turn.model)) }
            : {}),
        }
        // Not tied to the turn's signal: the process outlives the turn. An abort kills it below.
        runner = startRunner(
          await sandbox.spawn({
            command: `exec node ${shellQuote(runnerPath)} ${shellQuote(sessionDir)} ${n}`,
            workingDirectory: sessionWorkDir,
            env,
          }),
        )
      }
      const current = runner
      const translator = new CursorSdkStreamTranslator({
        agentId: agentId ?? undefined,
        workDir: sessionWorkDir,
      })
      const emit = (parts: HarnessV1StreamPart[]) => {
        for (const part of parts) turn.emit(part)
      }
      const onAbort = () => void stopRunner()
      if (turn.abortSignal?.aborted) onAbort()
      turn.abortSignal?.addEventListener('abort', onAbort, { once: true })
      const done = (async () => {
        try {
          while (!translator.finished) {
            const next = await current.stdout.next()
            if (next.done) break
            emit(translator.push(next.value))
          }
          if (!translator.finished) {
            if (runner === current) runner = undefined
            const { exitCode } = await current.proc.wait()
            emit(
              translator.end({
                exitCode,
                stderr: await current.stderr(),
                aborted: turn.abortSignal?.aborted === true,
              }),
            )
          }
        } finally {
          turn.abortSignal?.removeEventListener('abort', onAbort)
          agentId = translator.agentId ?? agentId
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

/**
 * The model with every parameter set: the ones given, then the rest from the catalog's default
 * variant (the SDK's own choice for an unset parameter), so nothing is left for the SDK to pick.
 */
export function withParams(
  id: string,
  given: Readonly<Record<string, string>> | undefined,
  catalog: readonly CursorSdkModelEntry[] | undefined,
): CursorSdkModel {
  const entry = catalog?.find((m) => m.id === id || m.aliases?.includes(id))
  const variants = Array.isArray(entry?.variants)
    ? (entry.variants as Array<{
        params?: Array<{ id: string; value: string }>
        isDefault?: boolean
      }>)
    : []
  const fallback = (variants.find((v) => v.isDefault) ?? variants[0])?.params ?? []
  const params = [
    ...Object.entries(given ?? {}).map(([pid, value]) => ({ id: pid, value })),
    ...fallback.filter((p) => !given || !(p.id in given)),
  ]
  return params.length ? { id, params } : { id }
}
