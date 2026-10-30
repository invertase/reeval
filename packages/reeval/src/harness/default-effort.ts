// The effort a harness runs at when its factory sets none: reeval's shared default, sent as each
// CLI's own setting so no CLI's default (Codex's `low` on gpt-5.6-sol, Grok Build's `high`)
// decides it, and left off where the harness, its gateway or its model takes no effort.
import { openCodeEffortBody, openCodeEffortRefusal } from '@reeval/harness-opencode/providers'
import { antigravityIdEffort, claudeCodeTakesEffort } from '../contract/harness.ts'
import { effortRefusedOn } from '../gateway/resolve.ts'
import { harnessId } from '../options.ts'
import type { CursorEfforts, HarnessDescriptor } from '../types.ts'
import { harnessEffort } from './effort.ts'

/** The effort every harness that takes one runs at when its factory sets none. */
export const DEFAULT_EFFORT = 'medium'

/**
 * Why `h` (routed to its gateway) runs with no effort when it sets none, or undefined when it
 * takes {@link DEFAULT_EFFORT}. Cursor's answer needs its catalog: without it, `unchecked`.
 */
export function noDefaultEffort(
  h: HarnessDescriptor,
  cursor?: CursorEfforts,
): string | 'unchecked' | undefined {
  switch (h.kind) {
    case 'fake':
      return 'the fake harness calls no model'
    case 'cursor': {
      const known = cursor && Object.hasOwn(cursor, h.model) ? cursor[h.model] : undefined
      if (known === undefined) return 'unchecked'
      if (known === null) return `Cursor's model catalog lists no effort for ${h.model}`
      if (h.params?.[known.param] !== undefined) return `params.${known.param} sets it`
      if (!known.levels.includes(DEFAULT_EFFORT)) {
        return `${h.model} takes effort ${known.levels.join(', ')}, not ${DEFAULT_EFFORT}`
      }
      return undefined
    }
    case 'claude-code':
      return claudeCodeTakesEffort(h.model)
        ? undefined
        : `Claude Code sends no effort to ${h.model}`
    case 'antigravity': {
      const named = antigravityIdEffort(h.model)
      return named ? `the model id names its effort, ${named}` : undefined
    }
    case 'opencode': {
      const refused = openCodeEffortRefusal(h.model)
      if (refused) return refused
      if ((h.gateway ?? 'direct') === 'direct' && !openCodeEffortBody(h.model, DEFAULT_EFFORT)) {
        return `reeval sends OpenCode's effort in no field ${h.model} is known to read`
      }
      return effortRefusedOn(h, h.gateway ?? 'direct')
    }
    default:
      return effortRefusedOn(h, h.gateway ?? 'direct')
  }
}

/**
 * The plan's notes on one eval's harnesses: each that runs with no effort and why, and the
 * efforts its cells run at when they differ and a cell id doesn't say so. `unchecked` says why a
 * Cursor model's catalog wasn't read.
 */
export function effortNotes(
  harnesses: readonly HarnessDescriptor[],
  cursor: CursorEfforts | undefined,
  unchecked: string,
): string[] {
  const efforts = new Map<string, string>()
  const notes: string[] = []
  for (const h of harnesses) {
    const id = harnessId(h)
    if (h.kind === 'fake' || efforts.has(id)) continue
    const effort = harnessEffort(h)
    if (effort !== undefined) {
      efforts.set(id, effort)
      continue
    }
    const why = noDefaultEffort(h, cursor)
    if (why === 'unchecked') {
      efforts.set(id, 'not checked')
      notes.push(`effort: ${id} not checked against Cursor's model catalog (${unchecked})`)
    } else {
      efforts.set(id, 'none')
      notes.push(`effort: ${id} none (${why})`)
    }
  }
  const hidden = [...efforts].some(([id, effort]) => !id.includes(`[effort=${effort}]`))
  if (new Set(efforts.values()).size > 1 && hidden) {
    const on = new Map<string, string[]>()
    for (const [id, effort] of efforts) on.set(effort, [...(on.get(effort) ?? []), id])
    notes.push(
      `efforts differ: ${[...on].map(([effort, ids]) => `${effort} on ${ids.join(', ')}`).join('; ')}`,
    )
  }
  return notes
}

/**
 * `h` with the effort it runs at: its own, else {@link DEFAULT_EFFORT} where it takes one. A
 * defaulted harness keeps its cell id, which names an effort only when the factory set one.
 */
export function withDefaultEffort(h: HarnessDescriptor, cursor?: CursorEfforts): HarnessDescriptor {
  if (harnessEffort(h) !== undefined) return h
  if (h.kind === 'cursor' && cursor && Object.hasOwn(cursor, h.model)) {
    const known = cursor[h.model]
    const set = known && h.params?.[known.param]
    if (set) return { ...h, id: harnessId(h), effort: set }
  }
  if (noDefaultEffort(h, cursor) !== undefined) return h
  return { ...h, id: harnessId(h), effort: DEFAULT_EFFORT }
}
