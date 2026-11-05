import { posix } from 'node:path'
import type { HarnessV1StreamPart } from '@ai-sdk/harness'
import { shellQuote } from '@ai-sdk/harness/utils'

/** Where the CLI keeps each step's output, by conversation, relative to the home directory. */
export const ANTIGRAVITY_BRAIN_DIR = '.gemini/antigravity-cli/brain'
/** The most of a saved output that's read: its first and last half past this. */
export const ANTIGRAVITY_SAVED_OUTPUT_MAX = 1024 * 1024

export type AntigravitySavedStep = { toolCallId: string; conversationId: string; step: number }
export type AntigravitySavedOutput = { text: string; bytes: number; cut: boolean }

export const savedOutputPath = (home: string, s: AntigravitySavedStep) =>
  posix.join(
    home,
    ANTIGRAVITY_BRAIN_DIR,
    s.conversationId,
    '.system_generated',
    'steps',
    String(s.step),
    'output.txt',
  )

/** Prints the file's size on the first line, then the file, or its first and last half. */
export function savedOutputScript(path: string, max = ANTIGRAVITY_SAVED_OUTPUT_MAX): string {
  const half = Math.floor(max / 2)
  const f = shellQuote(path)
  return [
    `[ -f ${f} ] || exit 3`,
    `n=$(wc -c < ${f})`,
    `echo "$n"`,
    `if [ "$n" -le ${max} ]; then cat ${f}; else`,
    `head -c ${half} ${f}; printf '\\n[… %s bytes cut …]\\n' "$((n - ${2 * half}))"; tail -c ${half} ${f}; fi`,
  ].join('\n')
}

export function parseSavedOutput(
  stdout: string,
  max = ANTIGRAVITY_SAVED_OUTPUT_MAX,
): AntigravitySavedOutput | undefined {
  const newline = stdout.indexOf('\n')
  const bytes = Number(stdout.slice(0, newline).trim())
  if (newline < 0 || !Number.isFinite(bytes)) return undefined
  return { text: stdout.slice(newline + 1), bytes, cut: bytes > max }
}

/**
 * Puts a saved output in its call's result, which agy reported with none. The provider metadata
 * says it's the tool's whole output and, when only part was read, the file's size.
 */
export function fillSavedOutput(
  parts: HarnessV1StreamPart[],
  toolCallId: string,
  saved: AntigravitySavedOutput,
): void {
  const i = parts.findIndex((p) => p.type === 'tool-result' && p.toolCallId === toolCallId)
  const part = parts[i]
  if (part?.type !== 'tool-result' || part.isError) return
  parts[i] = {
    ...part,
    result: saved.text,
    providerMetadata: {
      ...part.providerMetadata,
      antigravity: { toolOutput: { view: 'full', ...(saved.cut ? { bytes: saved.bytes } : {}) } },
    },
  }
}
