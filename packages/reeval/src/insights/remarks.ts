// The gates on the insight model's remarks, in code: a remark is kept only when its kind is one the
// model may raise, its text keeps the sentence rules, and its `source` quote is verbatim on the
// cited line of the file as the run saw it (the file's sha256 is the run's), a line of the eval's
// declaration the model was shown. A remark that fails
// a gate is dropped, never asked for again; the severity is its kind's. Its evidence and fix are
// the model's, carried as written: a fix at no line of the file points at the quoted line.

import type { EvalEntry } from '../history/types.ts'
import { sha256 } from '../ids.ts'
import type { Candidate } from '../remarks/rules.ts'
import { quotedRemarkId } from '../remarks/rules.ts'
import { oneLine } from '../text.ts'
import { MODEL_REMARK_KINDS, REMARK_KINDS, type Remark } from '../view/insights.ts'
import type { InsightInput } from './input.ts'
import { ID_IN_TEXT } from './input.ts'
import type { InsightsOutput } from './schema.ts'
import { type Drop, MAX_WORDS } from './validate.ts'

type Output = InsightsOutput['remarks'][number]

/** What the gates check a remark against: the eval's input, its record entries and its files. */
export type RemarkGate = {
  input: InsightInput
  /** The eval's record entries (a family's cases), whose sources hold the run's file hashes. */
  entries: EvalEntry[]
  /** Each source file's text now, by its path; null when it can't be read. */
  files: Map<string, string | null>
}

const MIN_QUOTE_CHARS = 3
const LINE_AT = /^(?:source:(.+)#|#)?L(\d+)$/
const words = (s: string) => s.match(/\S+/g)?.length ?? 0

/** `source:<file>#L<n>`, `#L<n>` or `L<n>` (in the eval's file) as a path and a 1-based line. */
function lineAt(at: string, file: string): { path: string; line: number } | null {
  const m = LINE_AT.exec(at.trim())
  if (!m) return null
  return { path: m[1] ?? file, line: Number(m[2]) }
}

/**
 * The model's remarks on one eval, held to the gates: those kept, as candidates with the kind's
 * severity, and a drop for each refused, its slot `<eval> › remark <kind>`.
 */
export function gateRemarks(
  output: Output[],
  gate: RemarkGate,
): { kept: Candidate[]; dropped: Drop[] } {
  const { input, entries, files } = gate
  const evalFile = input.source?.file ?? input.eval.file
  const hashes = new Map(entries.flatMap((e) => e.sources.map((s) => [s.path, s.sha256] as const)))
  // Only the lines the model was shown: any other line of the file is another eval's.
  const shown = new Set((input.source?.lines ?? []).map((l) => Number(/^L(\d+)/.exec(l)?.[1])))
  const kept: Candidate[] = []
  const dropped: Drop[] = []
  const seen = new Set<string>()
  const first = entries[0]
  for (const r of output) {
    const text = oneLine(r.text ?? '')
    const why = check(r, text)
    if (typeof why === 'string') {
      dropped.push({ slot: `${input.eval.name} › remark ${r.kind}`, text, reason: why })
      continue
    }
    seen.add(why.kind)
    kept.push(why)
  }
  return { kept, dropped }

  function line(at: string): { path: string; line: number; text: string } | string {
    const where = lineAt(at, evalFile)
    if (!where) return `cites ${at}, which isn't a line (L<n>)`
    if (!hashes.has(where.path)) return `cites ${where.path}, which isn't one of the eval's files`
    const body = files.get(where.path)
    if (body === null || body === undefined) return `can't be checked: ${where.path} can't be read`
    if (sha256(body) !== hashes.get(where.path)) {
      return `can't be checked: ${where.path} changed since the run`
    }
    const lines = body.split('\n')
    if (where.line < 1 || where.line > lines.length) {
      return `cites line ${where.line} of ${where.path}, which has ${lines.length}`
    }
    if (where.path !== evalFile || !shown.has(where.line)) {
      return `cites line ${where.line} of ${where.path}, which isn't in the eval's declaration`
    }
    return { ...where, text: lines[where.line - 1] as string }
  }

  function check(r: Output, text: string): Candidate | string {
    const kind = r.kind as Remark['kind']
    if (!MODEL_REMARK_KINDS.includes(kind))
      return `is kind "${r.kind}", which the model can't raise`
    if (seen.has(kind)) return `is a second ${kind} remark on this eval`
    if (!first) return "isn't on an eval the run recorded"
    if (!text) return 'is empty'
    if (words(text) > MAX_WORDS) return `is ${words(text)} words, more than ${MAX_WORDS}`
    if (ID_IN_TEXT.test(text)) return 'names a fact id in its text'
    if (!r.source) return 'has no source quote'
    const at = line(r.source.at)
    if (typeof at === 'string') return at
    const quote = r.source.quote?.trim() ?? ''
    if (quote.length < MIN_QUOTE_CHARS) return 'has no source quote'
    if (!at.text.includes(quote)) {
      return `quotes "${quote}", which isn't on line ${at.line} of ${at.path}`
    }
    const source = `source:${at.path}#L${at.line}`
    const fixAt = r.fix ? line(r.fix.at) : null
    return {
      id: quotedRemarkId(kind, input.eval.path, quote),
      evalId: input.eval.path,
      kind,
      severity: REMARK_KINDS[kind].severity,
      text,
      source: { at: source, quote },
      evidence: [...new Set((r.evidence ?? []).map((c) => c.trim()).filter(Boolean))],
      fix: {
        at: fixAt && typeof fixAt !== 'string' ? `source:${fixAt.path}#L${fixAt.line}` : source,
        edit: oneLine(r.fix?.edit ?? ''),
      },
      origin: 'model',
    }
  }
}
