import { clip, formatDuration } from '../text.ts'
import type { JudgeSees, TranscriptEvent } from '../types.ts'

/** Tool output and input beyond this many characters are clipped unless the judge sees `'full'`. */
export const TOOL_OUTPUT_CHARS = 300

type Mode = Exclude<JudgeSees['transcript'], false | undefined>

const text = (value: unknown) =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))

function toolInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    for (const key of ['command', 'cmd', 'path', 'file_path', 'url', 'query', 'pattern']) {
      if (typeof o[key] === 'string') return o[key]
    }
  }
  return text(input)
}

const indent = (block: string) =>
  block
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')

/**
 * A turn's transcript as one entry per event, for the judge: compact lines, not raw events.
 * `true` shows messages and tool calls, `'tools'` tool calls only, `'full'` adds reasoning and
 * leaves tool input and output whole.
 */
export function transcriptForJudge(
  events: readonly TranscriptEvent[],
  mode: Mode,
  clipped = mode !== 'full',
): string[] {
  const full = mode === 'full'
  const cut = (s: string) => (clipped ? clip(s, TOOL_OUTPUT_CHARS) : s)
  const took = (ms: number | null) => (ms === null ? '' : ` · ${formatDuration(ms)}`)
  const out: string[] = []
  for (const e of events) {
    switch (e.type) {
      case 'text':
        if (mode !== 'tools') out.push(`message: ${e.text}`)
        break
      case 'reasoning':
        if (full) out.push(`reasoning: ${e.text}`)
        break
      case 'file-edit': {
        const lines = e.added === null ? '' : `, +${e.added} −${e.removed ?? 0}`
        out.push(`edit ${e.path} (${e.kind}${lines})${took(e.durationMs)}`)
        break
      }
      case 'web-search':
        out.push(
          `search ${JSON.stringify(e.query)} → ${e.ok === false ? 'failed' : 'ok'}${took(e.durationMs)}`,
        )
        break
      case 'web-fetch':
        out.push(`fetch ${e.url} → ${e.ok ? 'ok' : 'failed'}${took(e.durationMs)}`)
        break
      case 'tool': {
        const head = `tool ${e.tool}: ${cut(toolInput(e.input))} → ${e.ok ? 'ok' : 'failed'}${took(e.durationMs)}`
        const output = e.output === undefined || e.output === null ? '' : cut(text(e.output)).trim()
        out.push(output ? `${head}\n${indent(output)}` : head)
        break
      }
      case 'error':
        out.push(`error: ${e.message}`)
        break
      case 'retry':
        out.push(`retry: ${e.message}`)
        break
    }
  }
  return out
}
