import { isObjectLike } from '../object.ts'
import { cutOutsideSecrets } from '../redact.ts'
import { clip, formatDuration } from '../text.ts'
import type { JudgeInputs, TranscriptEvent } from '../types.ts'

/** Tool output and input beyond this many characters are clipped unless the judge sees `'full'`. */
export const TOOL_OUTPUT_CHARS = 300

type Mode = Exclude<JudgeInputs['transcript'], false | undefined>

const text = (value: unknown) =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))

function toolInput(input: unknown): string {
  if (isObjectLike(input)) {
    for (const key of ['command', 'cmd', 'path', 'file_path', 'url', 'query', 'pattern']) {
      const value = input[key]
      if (typeof value === 'string') return value
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
export function transcriptForJudge(events: readonly TranscriptEvent[], mode: Mode): string[] {
  const full = mode === 'full'
  const cut = (s: string) => {
    const c = full ? s : clip(s, TOOL_OUTPUT_CHARS)
    if (c === s) return s
    const kept = c.length - 1
    const at = cutOutsideSecrets(s, kept)
    return at < kept ? `${s.slice(0, at).trimEnd()}…` : c
  }
  const took = (ms: number | null) => (ms === null ? '' : ` · ${formatDuration(ms)}`)
  const result = (ok: boolean | null | undefined) =>
    ok === null ? 'unfinished' : ok === false ? 'failed' : 'ok'
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
        const removed = e.removed === null ? '' : ` −${e.removed}`
        const lines = e.added === null ? '' : `, +${e.added}${removed}`
        out.push(`edit ${e.path} (${e.kind}${lines})${took(e.durationMs)}`)
        break
      }
      case 'web-search':
        out.push(`search ${JSON.stringify(e.query)} → ${result(e.ok)}${took(e.durationMs)}`)
        break
      case 'web-fetch':
        out.push(`fetch ${e.url} → ${result(e.ok)}${took(e.durationMs)}`)
        break
      case 'tool': {
        const head = `tool ${e.tool}: ${cut(toolInput(e.input))} → ${result(e.ok)}${took(e.durationMs)}`
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
