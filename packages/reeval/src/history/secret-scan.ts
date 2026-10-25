import { findSecrets, findSecretsInJson, maskedMatch, type SecretMatch } from '../redact.ts'
import { patchPath } from '../view/patch.ts'

/** Findings shown per file; the rest are counted. */
const SHOWN = 5

export type Finding = {
  /** The file inside a patch the match is in, else null. */
  file: string | null
  /** 1-based: in the patched file for a patch, else in the scanned file. Null outside a hunk. */
  line: number | null
  /** The rule, and for a credential shape with no known part its first and last four characters. */
  what: string
  /** The rule alone, with nothing of the value: safe to record. */
  rule: string
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** Where line `lineIndex` of a `git diff` falls: the file it changes, and its line in the new version. */
function inPatch(lines: string[], lineIndex: number): { file: string | null; line: number | null } {
  let file: string | null = null
  let next: number | null = null
  for (let i = 0; i <= lineIndex; i++) {
    const text = lines[i] as string
    if (text.startsWith('diff --git ')) {
      let end = i + 1
      while (end < lines.length && !/^(@@|diff --git )/.test(lines[end] as string)) end++
      file = patchPath(lines.slice(i, end).join('\n'))
      next = null
      continue
    }
    const hunk = HUNK.exec(text)
    if (hunk) {
      next = Number(hunk[1])
      continue
    }
    if (next === null) continue
    if (i === lineIndex) return { file, line: text.startsWith('-') ? null : next }
    if (!text.startsWith('-') && !text.startsWith('\\')) next++
  }
  return { file, line: null }
}

const JSON_FILE = /\.(?:json|jsonl|ndjson)$/

/**
 * Every secret-looking stretch of `text`, placed: by file and line inside a patch, else by line.
 * In a JSON file, only what redaction masks: its strings.
 */
export function scanText(path: string, text: string): Finding[] {
  const matches = JSON_FILE.test(path) ? findSecretsInJson(text) : findSecrets(text)
  if (matches.length === 0) return []
  const lines = text.split('\n')
  const starts: number[] = []
  let at = 0
  for (const line of lines) {
    starts.push(at)
    at += line.length + 1
  }
  const lineOf = (offset: number) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((starts[mid] as number) <= offset) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const patch = path.endsWith('.patch')
  return matches.map((m: SecretMatch) => {
    const index = lineOf(m.start)
    const where = patch ? inPatch(lines, index) : { file: null, line: index + 1 }
    return { ...where, what: maskedMatch(text, m), rule: m.rule }
  })
}

const place = (f: Finding) =>
  [f.file, f.line === null ? null : `line ${f.line}`].filter(Boolean).join(' ')

/** `<label> line <n>: <what>`, or `<label>: <file> line <n>: <what>` in a patch, a few per file. */
export function findingLines(label: string, findings: Finding[]): string[] {
  const out = findings.slice(0, SHOWN).map((f) => {
    const where = place(f)
    if (!where) return `${label}: ${f.what}`
    return `${label}${f.file ? ': ' : ' '}${where}: ${f.what}`
  })
  if (findings.length > SHOWN) out.push(`${label}: and ${findings.length - SHOWN} more`)
  return out
}

/** The findings as a recordable note: where, and which rule, never any part of the value. */
export function findingSummary(findings: Finding[]): string {
  const shown = findings.slice(0, 3).map((f) => {
    const where = place(f)
    return `${where ? `${where}: ` : ''}${f.rule}`
  })
  const more = findings.length > 3 ? `, and ${findings.length - 3} more` : ''
  return `${shown.join('; ')}${more}`
}
