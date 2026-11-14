// Which tool calls an attempt made, what each did and which skills it used, from its record and
// transcript.jsonl alone. `reeval query` stores these facts and the run report shows them, in any
// JavaScript runtime, so nothing this module reaches may use Node or the filesystem
// (test/view-boundary.test.ts holds it).
import { SKILL_DIRS } from '@reeval/agents/layouts'
import {
  type ClassContext,
  classifyCall,
  type SkillSource,
  skillDirSkill,
  skillsWritten,
  skillUses,
  type ToolClass,
} from '../history/tool-class.ts'
import { targetText, toolTarget } from '../history/tool-target.ts'
import type { AttemptRecord, RunRecord } from '../history/types.ts'
import type { TranscriptLine } from './model.ts'

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

type Event = Record<string, unknown>

/** The tool calls in a transcript's lines (`transcriptByLine`), numbered by line from 1. */
export function toolCalls(lines: readonly (TranscriptLine | null)[]): ToolCall[] {
  const calls: ToolCall[] = []
  lines.forEach((line, i) => {
    const event = line as Event | null
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
function skillsAuthored(lines: readonly (TranscriptLine | null)[], calls: ToolCall[]): Set<string> {
  const authored = new Set(calls.flatMap((t) => skillsWritten(t.tool, t.text)))
  for (const line of lines) {
    const event = line as Event | null
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
 * Classifies one attempt's tool calls from its transcript's lines: what `tool_calls`,
 * `context_reads`, `skill_uses` and `found_skills` hold, and what {@link attemptFacts} counts.
 */
export function classifyAttempt(
  a: AttemptRecord,
  env: { skills: string[]; mcp: string[] },
  lines: readonly (TranscriptLine | null)[] | undefined,
): AttemptCalls {
  const { skills } = env
  const calls = lines ? toolCalls(lines) : []
  const authored = lines ? skillsAuthored(lines, calls) : new Set<string>()
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

/** What one attempt's transcript shows it did, counted from its classified tool calls. */
export type AttemptFacts = {
  toolCalls: number
  byClass: Record<ToolClass, number>
  /** Each skill its calls used, by where it came from, in order of first use. */
  skills: Array<{
    skill: string
    source: SkillSource
    /** The calls that used it. */
    reads: number
    /** The transcript line of its first use, from 1. */
    firstLine: number
  }>
  /** Each placed context file its calls read, directly or through a glob, in order of first read. */
  contextFiles: Array<{ path: string; reads: number; firstLine: number }>
}

/**
 * One attempt's facts from its transcript's lines (as `transcriptByLine` parses them), its
 * calls classified as `reeval query`'s `tool_calls`, `context_reads` and `skill_uses` classify them,
 * against the skills and MCP servers of the attempt's environment in `record`.
 */
export function attemptFacts(
  record: RunRecord,
  attempt: AttemptRecord,
  lines: readonly (TranscriptLine | null)[],
): AttemptFacts {
  const digest = record.evals
    .find((e) => e.attempts.some((x) => x.key === attempt.key))
    ?.cells.find((c) => c.key === attempt.cell)?.environmentDigest
  const env = record.environments.find((x) => x.digest === (digest ?? ''))
  const declared = { skills: env?.skills.map((s) => s.name) ?? [], mcp: env?.mcp ?? [] }
  const byClass: AttemptFacts['byClass'] = {
    context: 0,
    dependency: 0,
    web: 0,
    verify: 0,
    workspace: 0,
  }
  const skills = new Map<string, AttemptFacts['skills'][number]>()
  const files = new Map<string, AttemptFacts['contextFiles'][number]>()
  const { calls } = classifyAttempt(attempt, declared, lines)
  for (const call of calls) {
    byClass[call.class]++
    for (const { skill, source } of call.skills) {
      const seen = skills.get(`${source}\0${skill}`)
      if (seen) seen.reads++
      else skills.set(`${source}\0${skill}`, { skill, source, reads: 1, firstLine: call.line })
    }
    for (const path of call.files) {
      const seen = files.get(path)
      if (seen) seen.reads++
      else files.set(path, { path, reads: 1, firstLine: call.line })
    }
  }
  return {
    toolCalls: calls.length,
    byClass,
    skills: [...skills.values()],
    contextFiles: [...files.values()],
  }
}
