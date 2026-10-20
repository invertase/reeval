// Holds the insight model's sentences to the facts and the plain-language rules. A sentence must
// cite only facts in its input (`SuiteResult` paths, or a transcript line shown to it); its numbers
// and quotes must be in what it cites; an effect word must be the cited fact's; it is 25 words or
// fewer a sentence; and a row sentence goes only on a row the layout opened. A sentence that fails
// is dropped. One that uses the statistics vocabulary (or a percentage under 10 tries) is
// `banned`: the caller asks once more, and drops it if it comes back the same.
import { unverifiedNumbers } from '../analysis/validate.ts'
import type { EvalInsight, Sentence } from '../view/insights.ts'
import { EFFECT_WORDS, type HeadlineInput, type InsightInput, type InsightSlots } from './input.ts'
import type { HeadlineOutput, InsightsOutput } from './schema.ts'

/** The most words a sentence may have. */
export const MAX_WORDS = 25
/** Below this many tries, a count is `N of M`, never a percentage. */
export const PERCENT_MIN_TRIES = 10

/** Words the output never uses: the statistics behind a verdict, and reeval's own terms for cells. */
export const BANNED: Array<{ word: string; pattern: RegExp }> = [
  { word: 'within noise', pattern: /\bwithin (the )?noise\b/i },
  { word: 'too close to call', pattern: /\btoo close to call\b/i },
  { word: 'effect size', pattern: /\beffect sizes?\b/i },
  { word: 'interval', pattern: /\bintervals?\b/i },
  { word: 'significance', pattern: /\b(statistical(ly)? )?significan(ce|t|tly)\b/i },
  { word: 'noise', pattern: /\bnois(e|y)\b/i },
  { word: 'p-value', pattern: /\bp-?values?\b|\bp\s*[<=>≤]\s*0?\.\d/i },
  { word: 'confidence', pattern: /\bconfiden(ce|t)\b/i },
  { word: 'Newcombe', pattern: /\bnewcombe\b/i },
  { word: 'Wilson', pattern: /\bwilson\b/i },
  { word: 'pass@1', pattern: /\bpass@1\b/i },
  { word: 'lift', pattern: /\blifts?\b/i },
  { word: 'control', pattern: /\bcontrols?\b/i },
  { word: 'variant', pattern: /\bvariants?\b/i },
  { word: 'arm', pattern: /\barms?\b/i },
  { word: 'cell', pattern: /\bcells?\b/i },
  { word: 'discriminates', pattern: /\bdiscriminat\w*/i },
]

const TRANSCRIPT = /^transcript:(.+)#L(\d+)$/
const QUOTE = /["“”]([^"“”]+)["“”]/g
const PERCENT = /\d\s*%|\bper ?cent\b/i
const EFFECT_PHRASES = Object.values(EFFECT_WORDS).map((w) => ({
  word: w,
  pattern: new RegExp(`\\b${w.replace("'", "['’]")}`, 'i'),
}))

const normal = (s: string) =>
  s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase()

/** Every string and number in a value, one a line: the text a citation stands for. */
function flatText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(flatText).join('\n')
  if (typeof value === 'object') return Object.values(value).map(flatText).join('\n')
  return ''
}

/** What a sentence's checks need: what each citation stands for, and the eval's own words. */
export type Citable = {
  /** The text a citation stands for, or null when it names nothing the model was shown. */
  resolve: (cite: string) => string | null
  /** The effect words of what a citation names. */
  effects: (cite: string) => string[]
  /** The eval's own names, lower-cased: a banned word that's one of them may be used. */
  vocabulary: string
}

export function citableEval(
  input: Pick<InsightInput, 'facts' | 'attempts' | 'eval' | 'checks'>,
): Citable {
  const facts = new Map(input.facts.map((f) => [f.path, f]))
  const attempts = new Map(input.attempts.map((a) => [a.id, a]))
  const resolve = (cite: string) => {
    const fact = facts.get(cite)
    if (fact) return flatText(fact)
    const t = TRANSCRIPT.exec(cite)
    if (!t) return null
    const [, id = '', n = ''] = t
    return attempts.get(id)?.lines.find((l) => l.startsWith(`L${n} `)) ?? null
  }
  const effects = (cite: string) => {
    const effect = facts.get(cite)?.effect
    return typeof effect === 'string' ? [effect] : []
  }
  const vocabulary = normal(
    [
      input.eval.name,
      ...input.eval.group,
      input.eval.file,
      ...input.checks,
      ...input.facts.flatMap((f) => [f.label, f.arm, f.harness, f.sandbox].map(flatText)),
    ].join('\n'),
  )
  return { resolve, effects, vocabulary }
}

export function citableHeadline(input: HeadlineInput): Citable {
  const evals = new Map(input.evals.map((e) => [e.path, e]))
  return {
    resolve: (cite) => {
      const e = evals.get(cite)
      return e ? flatText({ ...e, tally: input.tally }) : null
    },
    effects: () => [],
    vocabulary: normal(input.evals.map((e) => e.name).join('\n')),
  }
}

/** A kept sentence, or why it was dropped; `banned` ones may be asked for again. */
export type Verdict = { ok: Sentence } | { dropped: string } | { banned: string }

const sentencesOf = (text: string) => text.split(/(?<=[.!?])\s+(?=\S)/).filter((s) => s.trim())
const wordsOf = (text: string) => text.match(/\S+/g)?.length ?? 0

/** The largest `of M` in the cited facts: how many tries the sentence's counts are over. */
const triesOf = (texts: string[]) =>
  Math.max(0, ...texts.flatMap((t) => [...t.matchAll(/\bof (\d+)\b/g)].map((m) => Number(m[1]))))

/** One sentence against what it cites; `maxSentences` caps an answer at two. */
export function checkSentence(s: Sentence, c: Citable, maxSentences = 1): Verdict {
  const text = s.text.trim()
  const cites = [...new Set(s.cites.map((x) => x.trim()).filter(Boolean))]
  if (!text) return { dropped: 'empty' }
  if (!cites.length) return { dropped: `"${text}" cites nothing` }
  const texts: string[] = []
  for (const cite of cites) {
    const t = c.resolve(cite)
    if (t === null) return { dropped: `"${text}" cites ${cite}, which isn't a fact it was shown` }
    texts.push(t)
  }
  const parts = sentencesOf(text)
  if (parts.length > maxSentences) {
    return { dropped: `"${text}" is ${parts.length} sentences, more than ${maxSentences}` }
  }
  const long = parts.find((p) => wordsOf(p) > MAX_WORDS)
  if (long) return { dropped: `"${long}" is ${wordsOf(long)} words, more than ${MAX_WORDS}` }
  const banned = BANNED.find((b) => b.pattern.test(text) && !b.pattern.test(c.vocabulary))
  if (banned) return { banned: `"${text}" says "${banned.word}"; use plain words` }
  if (PERCENT.test(text) && triesOf(texts) < PERCENT_MIN_TRIES) {
    return {
      banned: `"${text}" gives a percentage below ${PERCENT_MIN_TRIES} tries; say N of M tries`,
    }
  }
  const haystack = normal(texts.join('\n'))
  for (const [, quote = ''] of text.matchAll(QUOTE)) {
    if (!haystack.includes(normal(quote))) {
      return { dropped: `"${text}" quotes "${quote}", which isn't in what it cites` }
    }
  }
  const numbers = unverifiedNumbers(text, texts)
  if (numbers.length) {
    return { dropped: `"${text}" has ${numbers.join(', ')}, which no cited fact has` }
  }
  const effects = new Set(cites.flatMap(c.effects))
  for (const e of EFFECT_PHRASES) {
    if (e.pattern.test(text) && !effects.has(e.word)) {
      return { dropped: `"${text}" says "${e.word}", but no cited fact's effect is` }
    }
  }
  return { ok: { text, cites } }
}

/** What the checks did to one answer: what's kept, what's dropped and what may be asked again. */
export type Checked<T> = { value: T; dropped: string[]; banned: string[] }

function tally<T>(value: T, verdicts: Verdict[]): Checked<T> {
  return {
    value,
    dropped: verdicts.flatMap((v) => ('dropped' in v ? [v.dropped] : [])),
    banned: verdicts.flatMap((v) => ('banned' in v ? [v.banned] : [])),
  }
}

type EvalSentences = Pick<EvalInsight, 'answer' | 'findings' | 'rows' | 'namedTools'>

/**
 * An eval's insights call, checked. `texts` holds each attempt's whole final message, which a
 * named tool must appear in verbatim.
 */
export function validateEvalInsights(
  output: InsightsOutput,
  input: InsightInput,
  slots: InsightSlots,
  texts: Map<string, string>,
): Checked<EvalSentences> {
  const c = citableEval(input)
  const verdicts: Verdict[] = []
  const keep = (s: Sentence, max = 1) => {
    const v = checkSentence(s, c, max)
    verdicts.push(v)
    return 'ok' in v ? v.ok : null
  }
  const answer = output.answer ? keep(output.answer, 2) : null
  const findings = output.findings.flatMap((s, i) => {
    if (!slots.findings) {
      verdicts.push({ dropped: `findings[${i}]: this eval's layout has no findings` })
      return []
    }
    const kept = keep(s)
    return kept ? [kept] : []
  })
  const open = new Set(slots.rows)
  const filled = new Set<string>()
  const rows = output.rows.flatMap((r) => {
    if (!open.has(r.row)) {
      verdicts.push({
        dropped: `rows: ${r.row} isn't a row this eval's layout takes a sentence on`,
      })
      return []
    }
    if (filled.has(r.row)) {
      verdicts.push({ dropped: `rows: a second sentence on ${r.row}` })
      return []
    }
    const kept = keep(r)
    if (!kept) return []
    filled.add(r.row)
    return [{ ...kept, row: r.row }]
  })
  const namedTools = output.namedTools.flatMap((n) => {
    if (!slots.namedTools) {
      verdicts.push({ dropped: `namedTools: ${n.attempt} isn't on a choose eval` })
      return []
    }
    const text = texts.get(n.attempt)
    if (text === undefined) {
      verdicts.push({ dropped: `namedTools: ${n.attempt} isn't an attempt it was shown` })
      return []
    }
    const tools = [...new Set(n.tools.map((t) => t.trim()).filter(Boolean))].filter((t) => {
      if (text.includes(t)) return true
      verdicts.push({ dropped: `namedTools: "${t}" isn't in ${n.attempt}'s final message` })
      return false
    })
    return tools.length ? [{ attempt: n.attempt, tools }] : []
  })
  return tally(
    {
      answer,
      findings,
      ...(rows.length ? { rows } : {}),
      ...(namedTools.length ? { namedTools } : {}),
    },
    verdicts,
  )
}

export function validateHeadline(
  output: HeadlineOutput,
  input: HeadlineInput,
): Checked<Sentence | null> {
  if (!output.headline) return { value: null, dropped: [], banned: [] }
  const v = checkSentence(output.headline, citableHeadline(input))
  return tally('ok' in v ? v.ok : null, [v])
}
