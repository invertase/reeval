// The gates on the insight model's remarks, all in code: a remark is kept only when its kind is
// one the model may raise, its `source` quote is on the cited line of the file as the run saw it
// (the file's sha256 is the run's), every piece of evidence is a fact or transcript line from this
// run, its fix is a concrete edit at a line of the eval's source, and what its kind says matches
// the run (the classification for the name kinds, a judge check's result for the judge kinds).
// A remark that fails a gate is dropped, never asked for again; the severity is its kind's.

import type { EvalEntry } from '../history/types.ts'
import { sha256 } from '../ids.ts'
import type { Candidate } from '../remarks/rules.ts'
import { quotedRemarkId } from '../remarks/rules.ts'
import { oneLine } from '../text.ts'
import { MODEL_REMARK_KINDS, REMARK_KINDS, type Remark } from '../view/insights.ts'
import type { InsightInput } from './input.ts'
import { ID_IN_TEXT } from './input.ts'
import type { InsightsOutput } from './schema.ts'
import { citableEval, type Drop, MAX_WORDS } from './validate.ts'

type Output = InsightsOutput['remarks'][number]

/** What the gates check a remark against: the eval's input, its record entries and its files. */
export type RemarkGate = {
  input: InsightInput
  /** The classification's reading of the name. */
  name: 'states-intent' | 'no-intent' | 'contradicts'
  /** The eval's record entries (a family's cases), whose sources hold the run's file hashes. */
  entries: EvalEntry[]
  /** Each source file's text now, by its path; null when it can't be read. */
  files: Map<string, string | null>
}

/** An edit that only advises: "consider clarifying", "maybe make it stricter". */
const VAGUE =
  /^(consider|maybe|perhaps|possibly|think about|try to|you (could|might|may|should))\b/i
const MIN_FIX_WORDS = 3
const MIN_QUOTE_CHARS = 3
const LINE_AT = /^(?:source:(.+))?#?L(\d+)$/
const words = (s: string) => s.match(/\S+/g)?.length ?? 0

/** `source:<file>#L<n>`, `#L<n>` or `L<n>` (in the eval's file) as a path and a 1-based line. */
function lineAt(at: string, file: string): { path: string; line: number } | null {
  const m = LINE_AT.exec(at.trim())
  if (!m) return null
  return { path: m[1] ?? file, line: Number(m[2]) }
}

/** A judge check fact's passes and tries (`2 of 3 passed`), or null for anything else. */
function judgeResult(fact: Record<string, unknown> | undefined) {
  if (fact?.kind !== 'check' || fact.judge !== true || typeof fact.result !== 'string') return null
  const m = /^(\d+) of (\d+) passed$/.exec(fact.result)
  return m ? { passed: Number(m[1]), tries: Number(m[2]) } : null
}

/** Why the remark's kind doesn't match this run, or null when it does. */
function mismatch(kind: Remark['kind'], evidence: string[], gate: RemarkGate): string | null {
  const facts = new Map(gate.input.facts.map((f) => [f.path, f]))
  const judges = evidence.flatMap((c) => judgeResult(facts.get(c)) ?? [])
  const intent = gate.input.intent
  switch (kind) {
    case 'name-contradicts':
      return gate.name === 'contradicts'
        ? null
        : "the classification didn't read the name as contradicted"
    case 'name-no-intent':
      return gate.name === 'no-intent' ? null : 'the classification read an intent in the name'
    case 'prompt-names-tool': {
      const tool = intent?.subject.tool
      if (intent?.job !== 'choose' || !tool) return "the eval isn't a choose eval with a tool"
      const named = gate.input.prompts.some((p) => p.toLowerCase().includes(tool.toLowerCase()))
      return named ? null : `no prompt names ${tool}`
    }
    case 'judge-too-loose':
    case 'judge-leaks-answer':
      return judges.some((j) => j.passed > 0) ? null : 'it cites no judge check that passed'
    case 'compound-judge':
      return judges.some((j) => j.passed < j.tries) ? null : 'it cites no judge check that failed'
    default:
      return null
  }
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
  const resolve = citableEval(input).resolve
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
    const evidence = [...new Set((r.evidence ?? []).map((c) => c.trim()).filter(Boolean))]
    if (!evidence.length) return 'cites no evidence from this run'
    const unknown = evidence.find((c) => resolve(c) === null)
    if (unknown) return `cites ${unknown}, which isn't a fact from this run`
    if (!r.fix) return 'has no fix'
    const fixAt = line(r.fix.at)
    if (typeof fixAt === 'string') return `has a fix that ${fixAt}`
    const edit = oneLine(r.fix.edit ?? '')
    if (words(edit) < MIN_FIX_WORDS || VAGUE.test(edit)) {
      return `has a fix, "${edit}", that isn't a concrete edit`
    }
    const wrong = mismatch(kind, evidence, gate)
    if (wrong) return `is ${kind}, but ${wrong}`
    return {
      id: quotedRemarkId(kind, input.eval.path, quote),
      evalId: input.eval.path,
      kind,
      severity: REMARK_KINDS[kind].severity,
      text,
      source: { at: `source:${at.path}#L${at.line}`, quote },
      evidence,
      fix: { at: `source:${fixAt.path}#L${fixAt.line}`, edit },
      origin: 'model',
    }
  }
}
