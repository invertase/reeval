import { posix } from 'node:path'
import type { HarnessV1 } from '@ai-sdk/harness'
import type { AgentKind, HarnessCatalogEntry } from './catalog/entry.ts'
import { HARNESSES } from './catalog/index.ts'
import { LAYOUTS } from './catalog/layouts.ts'
import { REFUSED_KEY, startAgent } from './driver/agent.ts'
import { errorText, type StampedPart } from './driver/transcript.ts'
import type { AgentLog, HarnessResult, HarnessSession } from './driver/types.ts'
import { AgentError } from './errors.ts'
import { type OutOptions, OutWriter } from './out/index.ts'
import type { OutSession } from './out/types.ts'
import type { Runner, RunnerInfo } from './runner.ts'
import type { ResolvedMcpServer } from './spec.ts'
import type { TranscriptEvent } from './types.ts'
import { AGENTS_VERSION } from './version.ts'

/** What a harness's adapter is built from. */
export type AdapterInput = {
  /** The session's credentials, by variable. */
  auth: Record<string, string>
  /** The model id the agent asks for: the harness entry's `modelId` of `model`. */
  model: string
  effort?: string
  /** The session's MCP servers, in the shape the harness's CLI takes them. */
  mcpServers?: Record<string, unknown>
}

/** Which harness a session runs, on which model, and how its AI SDK adapter is built. */
export type AgentHarness = {
  kind: AgentKind
  model: string
  effort?: string
  adapter: (input: AdapterInput) => HarnessV1 | Promise<HarnessV1>
}

/** A skill the session places for the agent: `SKILL.md` and its other files. */
export type AgentSkill = {
  name: string
  description: string
  /** `SKILL.md`'s body, under the frontmatter the session writes. */
  content: string
  files?: Array<{ path: string; content: string }>
  /**
   * `harness` (the default) hands it to the adapter, which places it where the agent reads its
   * own skills; `workspace` writes it into the workspace's skill directory.
   */
  placement?: 'harness' | 'workspace'
}

/** A start-up phase, or the session closing, with the milliseconds it took. */
export type AgentPhase = 'runner' | 'place' | 'bootstrap' | 'ready' | 'closed'

/**
 * What a session reports as it goes. A turn's `part` events arrive as the harness streams them
 * (only with `parts: true`); its `transcript` events once the turn ends, normalized.
 */
export type AgentEvent =
  | { type: 'phase'; phase: AgentPhase; ms: number }
  | { type: 'turn-start'; turn: number; prompt: string }
  | { type: 'part'; turn: number; part: StampedPart }
  | { type: 'transcript'; turn: number; event: TranscriptEvent }
  | { type: 'warning'; message: string }
  | { type: 'turn-end'; turn: number; result: HarnessResult }

export type AgentOptions = {
  harness: AgentHarness
  /**
   * Where the agent's CLI runs. A function's runner is the session's own, closed when the session
   * closes; a runner passed as is stays open for the caller.
   */
  runner: Runner | (() => Runner | Promise<Runner>)
  /** The credentials the adapter authenticates with, by variable; read again on each start. */
  credentials?:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>)
  /** The agent's workspace, relative to the runner's `cwd`; the `cwd` itself by default. */
  workDir?: string
  /** Written to the workspace file the harness reads rules from (`AGENTS.md`, `CLAUDE.md`). */
  rules?: string
  skills?: readonly AgentSkill[]
  mcp?: Record<string, ResolvedMcpServer>
  /** Where on the host to write what the session did. */
  out?: string | OutOptions
  /** Every event, the session's and its turns'. */
  onEvent?: (event: AgentEvent) => void
  /** Report each stream part as a `part` event. */
  parts?: boolean
  /** Where the harness reports what it does. */
  log?: AgentLog
  /** Aborting it stops the session starting, and any turn. */
  signal?: AbortSignal
}

/** A turn in flight: its events as they happen, and its result. */
export type AgentTurn = {
  events: AsyncIterable<AgentEvent>
  result: Promise<HarnessResult>
}

/** One agent conversation. */
export type AgentSession = {
  /** Starts the next turn; refused while one is running. */
  send(prompt: string, options?: { signal?: AbortSignal }): AgentTurn
  /**
   * Aborts a running turn, closes the harness session, then the runner when the session owns it.
   * Idempotent.
   */
  close(): Promise<void>
}

export type Agent = {
  start(): Promise<AgentSession>
  /** Starts a session, runs one turn and closes it. */
  exec(prompt: string, options?: { signal?: AbortSignal }): Promise<HarnessResult>
}

/** Events pushed in one place and read with `for await` in another, ending on `end()`. */
function channel<T>() {
  const buffered: T[] = []
  let waiting: ((r: IteratorResult<T>) => void) | undefined
  let ended = false
  return {
    push(value: T) {
      if (waiting) {
        waiting({ value, done: false })
        waiting = undefined
      } else buffered.push(value)
    },
    end() {
      ended = true
      waiting?.({ value: undefined, done: true })
      waiting = undefined
    },
    iterable: {
      [Symbol.asyncIterator]: (): AsyncIterator<T> => ({
        next: () => {
          const value = buffered.shift()
          if (value !== undefined) return Promise.resolve({ value, done: false })
          if (ended) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => {
            waiting = resolve
          })
        },
      }),
    } as AsyncIterable<T>,
  }
}

const skillMd = (skill: AgentSkill) =>
  `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n${skill.content}`

/**
 * A coding agent on a runner. `start()` asks the runner where it is, places the rules and skills,
 * builds the adapter and starts the harness's session; each `send` is a turn.
 */
export function agent(options: AgentOptions): Agent {
  const { harness } = options
  const entry: HarnessCatalogEntry = HARNESSES[harness.kind]
  const layout = LAYOUTS[harness.kind]
  const workDir = options.workDir ?? '.'
  const outOptions = typeof options.out === 'string' ? { dir: options.out } : options.out
  const emit = (event: AgentEvent) => {
    try {
      options.onEvent?.(event)
    } catch {}
  }

  async function start(): Promise<AgentSession> {
    const owned = typeof options.runner === 'function'
    const runner = typeof options.runner === 'function' ? await options.runner() : options.runner
    const credentials =
      typeof options.credentials === 'function'
        ? await options.credentials()
        : (options.credentials ?? {})
    const signal = options.signal ?? new AbortController().signal
    let out: OutWriter | undefined
    const warn = (message: string) => emit({ type: 'warning', message })
    const writing = (write: Promise<void> | undefined) =>
      write?.catch((error) => warn(`writing ${out?.dir}: ${errorText(error)}`))
    const log: AgentLog = {
      log: (phase, text) => {
        options.log?.log(phase, text)
        void writing(out?.log(`[${phase}] ${text}`))
      },
      trace: (phase, kind, data, show) => options.log?.trace(phase, kind, data, show),
    }
    const doc: OutSession = {
      schemaVersion: 1,
      agentsVersion: AGENTS_VERSION,
      harness: {
        kind: harness.kind,
        model: harness.model,
        ...(harness.effort ? { effort: harness.effort } : {}),
      },
      adapter: { name: '' },
      startedAt: new Date().toISOString(),
      phases: {},
      status: 'running',
    }
    const phase = (name: AgentPhase, since: number) => {
      const ms = Date.now() - since
      if (name === 'runner' || name === 'place' || name === 'bootstrap') doc.phases[name] = ms
      emit({ type: 'phase', phase: name, ms })
    }
    let session: HarnessSession
    let onPart: ((part: StampedPart) => void) | undefined
    const begun = Date.now()
    try {
      if (outOptions) out = await OutWriter.open(outOptions, Object.values(credentials))
      let since = Date.now()
      const info: RunnerInfo = await runner.info()
      doc.runner = info
      phase('runner', since)
      await writing(out?.session(doc))

      since = Date.now()
      if (options.rules !== undefined) {
        await runner.writeFile(posix.join(workDir, layout.rulesFile), options.rules)
      }
      const skills = options.skills ?? []
      for (const skill of skills.filter((s) => s.placement === 'workspace')) {
        const dir = posix.join(workDir, layout.workspaceSkillDir, skill.name)
        await runner.writeFile(`${dir}/SKILL.md`, skillMd(skill))
        for (const f of skill.files ?? []) await runner.writeFile(`${dir}/${f.path}`, f.content)
      }
      phase('place', since)

      since = Date.now()
      const model = entry.modelId?.(harness.model) ?? harness.model
      const mcp = options.mcp ?? {}
      const adapter = await harness.adapter({
        auth: credentials,
        model,
        ...(harness.effort ? { effort: harness.effort } : {}),
        ...(Object.keys(mcp).length ? { mcpServers: entry.mcpServers(mcp) } : {}),
      })
      doc.adapter = { name: adapter.harnessId }
      const names = Object.keys(credentials)
      const variable = names.length ? names.join(' or ') : (entry.credential ?? 'its credential')
      session = await startAgent({
        kind: harness.kind,
        entry,
        adapter,
        model,
        runner,
        workDir,
        skills: skills
          .filter((s) => s.placement !== 'workspace')
          .map((s) => ({
            name: s.name,
            description: s.description,
            content: s.content,
            files: s.files ?? [],
          })),
        signal,
        log,
        authHint: (message, refused) =>
          refused || REFUSED_KEY.test(message)
            ? `The API rejected ${variable} for the ${entry.name} harness`
            : undefined,
        ...(outOptions?.raw ? { raw: true } : {}),
        onPart: (part) => onPart?.(part),
      })
      phase('bootstrap', since)
    } catch (error) {
      doc.status = 'failed'
      doc.error = errorText(error)
      doc.endedAt = new Date().toISOString()
      await writing(out?.session(doc))
      await writing(out?.flush())
      if (owned) await runner.close().catch(() => {})
      throw error
    }
    await writing(out?.session(doc))
    emit({ type: 'phase', phase: 'ready', ms: Date.now() - begun })

    const closed = new AbortController()
    let turns = 0
    let running: Promise<unknown> | undefined
    let closing: Promise<void> | undefined

    return {
      send(prompt, sendOptions = {}) {
        if (closing) throw new AgentError('The session is closed')
        if (running) throw new AgentError('A turn is already running in this session')
        const turn = turns++
        const events = channel<AgentEvent>()
        const report = (event: AgentEvent) => {
          events.push(event)
          emit(event)
        }
        const turnSignal = AbortSignal.any(
          [signal, closed.signal, sendOptions.signal].filter(
            (s): s is AbortSignal => s !== undefined,
          ),
        )
        onPart = (part) => {
          void writing(out?.part(turn, part))
          if (options.parts) report({ type: 'part', turn, part })
        }
        report({ type: 'turn-start', turn, prompt })
        const result = (async () => {
          try {
            const result = await session.send(prompt, turnSignal)
            for (const event of result.transcript) report({ type: 'transcript', turn, event })
            await writing(out?.turn(turn, prompt, result))
            report({ type: 'turn-end', turn, result })
            return result
          } finally {
            onPart = undefined
            running = undefined
            events.end()
          }
        })()
        running = result.catch(() => {})
        return { events: events.iterable, result }
      },
      close() {
        closing ??= (async () => {
          const since = Date.now()
          closed.abort()
          await running
          await session.close()
          if (owned) await runner.close().catch(() => {})
          doc.status = 'closed'
          doc.endedAt = new Date().toISOString()
          await writing(out?.session(doc))
          await writing(out?.flush())
          phase('closed', since)
        })()
        return closing
      },
    }
  }

  return {
    start,
    async exec(prompt, execOptions) {
      const session = await start()
      try {
        return await session.send(prompt, execOptions).result
      } finally {
        await session.close()
      }
    },
  }
}
