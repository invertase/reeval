// Which tool calls an attempt made, what each did and which skills it used, from its record and
// transcript.jsonl alone. `reeval query` stores these facts and the studio view shows them, in Node,
// a browser or a Worker, so nothing this module reaches may use Node or the filesystem
// (test/view-boundary.test.ts holds it).
import { SKILL_DIRS } from '../harness/skill-dirs.ts'
import {
  type ClassContext,
  classifyCall,
  skillDirSkill,
  skillsWritten,
  skillUses,
  type ToolClass,
} from '../history/tool-class.ts'
import { targetText, toolTarget } from '../history/tool-target.ts'
import type { AttemptRecord } from '../history/types.ts'

const ADAPTER_HOME = /^~\/\.ai-sdk-harness\/\.harness-bootstrap\/[^/]+\/(?:implementation\/)?home\//

const RETIRED_RUNTIME_STATE = new Set([
  '.cursor/cli-config.json',
  '.cursor/skills-cursor/.sync-manifest.json',
])

/** A context path that is some agent CLI's own runtime state, whichever harness recorded it. */
export function isRuntimeState(path: string): boolean {
  if (!path.startsWith('~/')) return false
  return RETIRED_RUNTIME_STATE.has(path.replace(ADAPTER_HOME, '~/').slice(2))
}

/** The agent CLI's home config, which its harness writes (MCP servers, settings), not the eval. */
const HARNESS_CONFIG = /^~\/.*(^|\/)(config\.(toml|ya?ml|json)|settings(\.local)?\.json|mcp\.json)$/

/**
 * A placed file the environment declared: under one of its skills, or a rules file outside any
 * skills directory. Not an agent CLI's own state or home config, its bundled skills or the
 * adapter's skill index.
 */
export const declaredContext = (path: string, skills: string[]) =>
  !isRuntimeState(path) &&
  !path.endsWith('/.ai-sdk-harness-skills.json') &&
  !HARNESS_CONFIG.test(path) &&
  (skills.some((s) => path.includes(`skills/${s}/`)) || !/(^|\/)skills(-[^/]+)?\//.test(path))

export type ToolCall = {
  line: number
  turn: number | null
  tool: string
  target: string
  /** The target uncapped, which classifies the call. */
  text: string
  /** Null when the harness never reported the call's result. */
  ok: boolean | null
  durationMs: number | null
}

/** The tool calls in a transcript.jsonl, numbered by line from 1; lines that aren't JSON are skipped. */
export function toolCalls(transcript: string): ToolCall[] {
  const calls: ToolCall[] = []
  transcript.split('\n').forEach((line, i) => {
    if (!line.trim()) return
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    if (event?.type !== 'tool') return
    calls.push({
      line: i + 1,
      turn: typeof event.turn === 'number' ? event.turn : null,
      tool: String(event.tool ?? ''),
      target: toolTarget(event.input, String(event.tool ?? '')),
      text: targetText(event.input, String(event.tool ?? '')),
      ok: event.ok === null ? null : event.ok !== false,
      durationMs:
        typeof event.durationMs === 'number' && !event.durationInferred ? event.durationMs : null,
    })
  })
  return calls
}

/**
 * The skills whose `SKILL.md` an attempt wrote: by a file-editing tool that created or rewrote it,
 * or by a shell command (a redirect, `tee`, `cp` and the like).
 */
function skillsAuthored(transcript: string, calls: ToolCall[]): Set<string> {
  const authored = new Set(calls.flatMap((t) => skillsWritten(t.tool, t.text)))
  for (const line of transcript.split('\n')) {
    if (!line.includes('"file-edit"')) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.type !== 'file-edit' || (event.kind !== 'create' && event.kind !== 'write')) continue
    for (const name of skillsWritten('write', String(event.path ?? ''))) authored.add(name)
  }
  return authored
}

/** `classifyCall`, but a call its heuristic can't read counts as workspace: one transcript line can't stop the sync. */
function classifyOrWorkspace(
  tool: string,
  target: string,
  ctx: ClassContext,
): ReturnType<typeof classifyCall> & { skills: ReturnType<typeof skillUses> } {
  try {
    return {
      ...classifyCall(tool, target, ctx),
      skills: skillUses(tool, target, ctx.skills, ctx.skillDirs, ctx.found),
    }
  } catch {
    return { class: 'workspace', files: [], skills: [] }
  }
}

export type ClassifiedCall = ToolCall & {
  class: ToolClass
  /** The declared context files the call read. */
  files: string[]
  /** The skills the call used; a failed call or one on a skill the attempt wrote counts only placed ones. */
  skills: ReturnType<typeof skillUses>
}

/** One attempt's tool calls, classified, and the skills it found that its environment didn't place. */
export type AttemptCalls = {
  calls: ClassifiedCall[]
  found: Map<string, { source: string; path: string | null }>
}

/**
 * Classifies one attempt's tool calls from its transcript: what `tool_calls`, `context_reads`,
 * `skill_uses` and `found_skills` hold, and what the run view's facts count.
 */
export function classifyAttempt(
  a: AttemptRecord,
  env: { skills: string[]; mcp: string[] },
  transcript: string | undefined,
): AttemptCalls {
  const { skills } = env
  const calls = transcript ? toolCalls(transcript) : []
  const authored = transcript ? skillsAuthored(transcript, calls) : new Set<string>()
  const found = new Map<string, { source: string; path: string | null }>()
  for (const c of a.context) {
    const skill = isRuntimeState(c.path) ? undefined : skillDirSkill(c.path, SKILL_DIRS)
    if (skill && !skills.includes(skill) && !authored.has(skill) && !found.has(skill)) {
      found.set(skill, { source: 'skill-dir', path: c.path })
    }
  }
  const ctx: ClassContext = {
    skills,
    skillDirs: SKILL_DIRS,
    found: [...found.keys()],
    files: a.context.map((c) => c.path).filter((p) => declaredContext(p, skills)),
    mcp: env.mcp,
    verify: a.checks.map((c) => c.command),
  }
  const classified = calls.map((t): ClassifiedCall => {
    const call = classifyOrWorkspace(t.tool, t.text, ctx)
    // A failed call names a skill that may not exist; a placed one does.
    const used = call.skills.filter(
      ({ skill, source }) => source === 'placed' || (t.ok !== false && !authored.has(skill)),
    )
    for (const { skill, source } of used) {
      const had = found.get(skill)
      if (source !== 'placed' && had?.source !== 'skill-dir') {
        found.set(skill, { source, path: had?.path ?? null })
      }
    }
    return { ...t, class: call.class, files: call.files, skills: used }
  })
  return { calls: classified, found }
}
