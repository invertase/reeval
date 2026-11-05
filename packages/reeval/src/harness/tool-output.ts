import type { TranscriptEvent } from '../types.ts'

/** The most of one text in a tool's output the transcript keeps: its first and last half. */
export const TOOL_OUTPUT_MAX_BYTES = 128 * 1024

const byteLength = (text: string) => Buffer.byteLength(text, 'utf8')

/** A tool output's size in UTF-8 bytes: a text's own, or its JSON's. */
export function outputBytes(output: unknown): number {
  return byteLength(typeof output === 'string' ? output : (JSON.stringify(output) ?? ''))
}

/**
 * The first and last `max / 2` bytes of `text`, with a line between them saying how much was cut.
 * A character split at either edge is dropped.
 */
export function cutText(text: string, max = TOOL_OUTPUT_MAX_BYTES): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= max) return text
  const half = Math.floor(max / 2)
  const head = buffer
    .subarray(0, half)
    .toString('utf8')
    .replace(/\uFFFD+$/, '')
  const tail = buffer
    .subarray(buffer.length - half)
    .toString('utf8')
    .replace(/^\uFFFD+/, '')
  const cut = buffer.length - byteLength(head) - byteLength(tail)
  return `${head}\n[… ${cut} bytes cut …]\n${tail}`
}

function cutTexts(value: unknown, max: number, onCut: () => void): unknown {
  if (typeof value === 'string') {
    const cut = cutText(value, max)
    if (cut !== value) onCut()
    return cut
  }
  if (Array.isArray(value)) return value.map((v) => cutTexts(v, max, onCut))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cutTexts(v, max, onCut)]))
  }
  return value
}

/**
 * A tool event with each text in its output longer than `max` cut to its first and last half,
 * and `outputTruncated` set to the whole output's size (or the larger size the harness reported
 * for output it had already cut). Every other event, and a tool event with nothing to cut, is
 * returned as it is.
 */
export function fitToolOutput(
  event: TranscriptEvent,
  max = TOOL_OUTPUT_MAX_BYTES,
): TranscriptEvent {
  if (event.type !== 'tool') return event
  let cut = false
  const output = cutTexts(event.output, max, () => {
    cut = true
  })
  if (!cut) return event
  const bytes = Math.max(event.outputTruncated?.bytes ?? 0, outputBytes(event.output))
  return { ...event, output, outputTruncated: { bytes } }
}
