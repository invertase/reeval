// Holds the insight model's sentences to the facts and the plain-language rules. A sentence must
// cite only facts in its input (`SuiteResult` paths, or a transcript line shown to it); its numbers
// and quotes must be in what it cites (a count beside a named tool is that tool's count, not a
// pass count); an effect word must be the cited fact's, unless a stated
// "can't tell yet if/whether" governs it; it is 25 words or fewer a sentence; and a row sentence
// goes only on a row the layout opened. A sentence that fails is dropped. One that uses the
// statistics vocabulary (or a percentage under 10 tries) is `banned`: the caller asks once more,
// and drops it if it comes back the same.
import { unverifiedNumbers } from '../analysis/validate.ts'
import { oneLine } from '../text.ts'
import type { EvalInsight, Sentence } from '../view/insights.ts'
import {
  EFFECT_WORDS,
  type HeadlineInput,
  ID_IN_TEXT,
  type InsightInput,
  type InsightSlots,
} from './input.ts'
import type { HeadlineOutput, InsightsOutput } from './schema.ts'

/** The most words a sentence may have. */
export const MAX_WORDS = 25
/** The most findings an eval prints. */
const MAX_FINDINGS = 3
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
/** A quoted span: double, curly or backtick quotes, or single quotes that aren't an apostrophe. */
const QUOTE = /["“”]([^"“”]+)["“”]|‘(.+?)’(?!\w)|`([^`]+)`|(?<![\w'])'([^'\n]+?)'(?!\w)/g
const PERCENT = /\d\s*%|\bper ?cent\b/i
/**
 * Each effect's word and the claims that say it: the word itself and the plain words for it
 * (`helps`, `improved`, `worse`, `hurt`). A negated `help` (`didn't help`) claims no `helped`.
 */
const EFFECT_PHRASES = [
  {
    word: EFFECT_WORDS.better,
    pattern: /(?<!(?:n['’]t|\bnot|\bnever)\s+)\b(?:help(?:s|ed|ing)?|improv(?:e|es|ed|ing))\b/gi,
  },
  {
    word: EFFECT_WORDS.worse,
    pattern:
      /\b(?:(?:make|makes|made|making)\s+(?:it|things|them)\s+)?worse\b|\bhurt(?:s|ing)?\b/gi,
  },
  { word: EFFECT_WORDS.same, pattern: /\bno difference\b/gi },
  { word: EFFECT_WORDS.unclear, pattern: /\bcan['’]t tell yet\b/gi },
]
/**
 * A "can't tell yet if/whether …" clause, up to the end of its sentence, any comma, colon,
 * semicolon, dash or bracket, a conjunction, or an "and" that starts a new clause. It errs short:
 * a word past it is checked.
 */
const HEDGED =
  /\bcan['’]t tell yet (if|whether)\b.*?(?=[.,:;!?()–—]|\s-\s|\s+(but|while|though|although|whereas|yet|so|because)\b|\s+and\s+(it|they|the|this|that|its|their|with|plain)\b|$)/gi
const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
]
const COUNT = String.raw`(\d+|${NUMBER_WORDS.join('|')})`
/** `N of M`, `N out of M` or `N of the M`, in digits or words. */
const PAIR = new RegExp(
  String.raw`(?<![\w.])${COUNT}\s+(?:out\s+)?of\s+(?:the\s+|its\s+|their\s+)?${COUNT}\b`,
  'gi',
)
const FACT_PAIR = /\b(\d+) of (\d+)\b/g
const OUTCOME_VERB = /\b(?:pass|fail|succeed|miss)\w*/gi
const PASSED_AFTER = /^\s+(?:tries\s+|checks\s+)?pass(?:ed|es|ing)?\b/i
const SMALL = /(?<![\w.#/:-])\d(?![\w/]|\.\d)/g

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const countOf = (raw: string) => {
  const word = NUMBER_WORDS.indexOf(raw.toLowerCase())
  return word >= 0 ? word : Number(raw)
}

/** Where a count's clause starts: a clause mark, a dash, or the end of the count before it. */
const CLAUSE_END = /[.,:;!?()–—]|\s-\s/g

/** The tool a count's clause names after its last outcome verb, lower-cased, or null. */
function toolBefore(clause: string, tools: string[]): string | null {
  const verbAt = [...clause.matchAll(OUTCOME_VERB)].at(-1)?.index ?? -1
  let found: { tool: string; at: number } | null = null
  for (const tool of tools) {
    const re = new RegExp(`(?<!\\w)${escapeRegExp(tool)}(?!\\w)`, 'gi')
    const at = [...clause.matchAll(re)].at(-1)?.index ?? -1
    if (at > verbAt && (!found || at > found.at)) found = { tool, at }
  }
  return found ? found.tool.toLowerCase() : null
}

/** A sentence's tool counts: the tools it may name, and each one's counts over what it cites. */
type ToolCounts = { names: string[]; held: (tool: string) => Set<string> }

/**
 * The counts and numbers in `text` that what it cites doesn't hold. An `N of M` must be a cited
 * fact's own count (a transcript line's text isn't a count). When the facts count passes and the
 * nearest verb before it is a fail, it counts failures: `failed 4 of 4` over `0 of 4 passed`, and
 * `failed 0 of 4` there is dropped, unless `passed` follows it. A count whose clause names a tool
 * after its last outcome verb (`recommended Genkit in 1 of 1 tries`) counts the tries that named
 * it, so it must be that tool's count over a cited fact, not a pass count. Any other number must
 * be in what it cites, as `unverifiedNumbers` reads them, and a digit from 0 to 9 exactly.
 */
function unheldNumbers(
  text: string,
  facts: string[],
  all: string[],
  passCounts: boolean,
  tools?: ToolCounts,
): string[] {
  const known = new Set(facts.flatMap((f) => [...f.matchAll(FACT_PAIR)].map((m) => m[0])))
  const out: string[] = []
  let from = 0
  for (const m of text.matchAll(PAIR)) {
    const at = m.index ?? 0
    const n = countOf(m[1] as string)
    const of = countOf(m[2] as string)
    const before = text.slice(0, at)
    const passedAfter = PASSED_AFTER.test(text.slice(at + m[0].length))
    const clauseAt = Math.max(from, ...[...before.matchAll(CLAUSE_END)].map((c) => c.index + 1))
    from = at + m[0].length
    const tool = tools && !passedAfter ? toolBefore(before.slice(clauseAt), tools.names) : null
    if (tool !== null) {
      if (!tools?.held(tool).has(`${n} of ${of}`)) out.push(m[0])
      continue
    }
    const verb = [...before.matchAll(OUTCOME_VERB)].at(-1)?.[0] ?? ''
    const failures = passCounts && /^(fail|miss)/i.test(verb) && !passedAfter
    if (known.has(failures ? `${of - n} of ${of}` : `${n} of ${of}`)) continue
    out.push(m[0])
  }
  const rest = text.replace(PAIR, ' ')
  const digits = new Set(all.flatMap((t) => t.match(/\d+(?:\.\d+)?/g) ?? []))
  const small = (rest.match(SMALL) ?? []).filter((d) => !digits.has(d))
  return [...new Set([...out, ...small, ...unverifiedNumbers(rest, all)])]
}

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
  /** Whether each `N of M` it cites counts passes, so one after a fail verb counts failures. */
  passCounts: boolean
  /**
   * A choose eval's named tools and its subject, and a tool's count over what a citation names,
   * `N of M` as its row reads (the tries that named it over the tries counted), or null.
   */
  tools?: { names: string[]; count: (tool: string, cite: string) => string | null }
}

export function citableEval(
  input: Pick<InsightInput, 'facts' | 'attempts' | 'eval' | 'checks'>,
): Citable {
  const facts = new Map(input.facts.map((f) => [f.path, f]))
  const attempts = new Map(input.attempts.map((a) => [a.id, a]))
  const resolve = (cite: string) => {
    const fact = facts.get(cite)
    // The path is the fact's name, not what it holds: `%2F` in it isn't a 2.
    if (fact) return flatText({ ...fact, path: null })
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
  return { resolve, effects, vocabulary, passCounts: true }
}

export function citableHeadline(input: HeadlineInput): Citable {
  const evals = new Map(input.evals.map((e) => [e.path, e]))
  const { unit: _, total, errors: __, ...counts } = input.tally
  const ofTotal = Object.values(counts).map((n) => `${n} of ${total}`)
  return {
    resolve: (cite) => {
      const e = evals.get(cite)
      return e
        ? flatText({ ...e, path: null, tally: input.tally, ofTotal, evals: input.evals.length })
        : null
    },
    effects: () => [],
    vocabulary: normal(input.evals.map((e) => e.name).join('\n')),
    passCounts: false,
  }
}

/** A kept sentence, or why it was dropped; `banned` ones may be asked for again. */
export type Verdict = { ok: Sentence } | { dropped: string } | { banned: string }

const sentencesOf = (text: string) => text.split(/(?<=[.!?])\s+(?=\S)/).filter((s) => s.trim())
const sameText = (text: string) => oneLine(text).toLowerCase()
const wordsOf = (text: string) => text.match(/\S+/g)?.length ?? 0

/** The largest `of M` in the cited facts: how many tries the sentence's counts are over. */
const triesOf = (texts: string[]) =>
  Math.max(0, ...texts.flatMap((t) => [...t.matchAll(/\bof (\d+)\b/g)].map((m) => Number(m[1]))))

/** One sentence against what it cites; `maxSentences` caps an answer at two. */
export function checkSentence(s: Sentence, c: Citable, maxSentences = 1): Verdict {
  const text = oneLine(s.text)
  const cites = [...new Set(s.cites.map((x) => x.trim()).filter(Boolean))]
  if (!text) return { dropped: 'empty' }
  if (!cites.length) return { dropped: 'cites nothing' }
  const texts: string[] = []
  const factTexts: string[] = []
  for (const cite of cites) {
    const t = c.resolve(cite)
    if (t === null) return { dropped: `cites ${cite}, which isn't a fact it was shown` }
    texts.push(t)
    if (!TRANSCRIPT.test(cite)) factTexts.push(t)
  }
  const id = ID_IN_TEXT.exec(text)?.[0]
  if (id && !c.vocabulary.includes(normal(id)))
    return { banned: `names ${id} in its text; ids go in cites only` }
  const parts = sentencesOf(text)
  if (parts.length > maxSentences) {
    return { dropped: `is ${parts.length} sentences, more than ${maxSentences}` }
  }
  const long = parts.find((p) => wordsOf(p) > MAX_WORDS)
  if (long) {
    const which = parts.length > 1 ? `"${long}" ` : ''
    return { dropped: `${which}is ${wordsOf(long)} words, more than ${MAX_WORDS}` }
  }
  const banned = BANNED.find((b) => b.pattern.test(text) && !b.pattern.test(c.vocabulary))
  if (banned) return { banned: `says "${banned.word}"; use plain words` }
  if (PERCENT.test(text) && triesOf(texts) < PERCENT_MIN_TRIES) {
    return {
      banned: `gives a percentage below ${PERCENT_MIN_TRIES} tries; say N of M tries`,
    }
  }
  const haystack = normal(texts.join('\n'))
  for (const m of text.matchAll(QUOTE)) {
    const quote = m.slice(1).find((g) => g !== undefined) ?? ''
    if (!haystack.includes(normal(quote))) {
      return { dropped: `quotes "${quote}", which isn't in what it cites` }
    }
  }
  const factCites = cites.filter((cite) => !TRANSCRIPT.test(cite))
  const tools = c.tools && {
    names: c.tools.names,
    held: (tool: string) =>
      new Set(
        factCites
          .map((cite) => c.tools?.count(tool, cite))
          .filter((x): x is string => typeof x === 'string'),
      ),
  }
  const numbers = unheldNumbers(text, factTexts, texts, c.passCounts, tools)
  if (numbers.length) {
    return { dropped: `has ${numbers.join(', ')}, which no cited fact has` }
  }
  const effects = new Set(cites.flatMap(c.effects))
  // "can't tell yet if it helped" states the unclear effect; the word it governs isn't a claim.
  const claims = effects.has(EFFECT_WORDS.unclear) ? text.replace(HEDGED, '') : text
  for (const e of EFFECT_PHRASES) {
    if (effects.has(e.word)) continue
    const said = [...(e.word === EFFECT_WORDS.unclear ? text : claims).matchAll(e.pattern)]
      .map((m) => m[0])
      .find((w) => !new RegExp(`\\b${w}\\b`, 'i').test(c.vocabulary))
    if (said) return { dropped: `says "${said}", but no cited fact's effect is` }
  }
  return { ok: { text, cites } }
}

/** A sentence the checks refused: where it was going, what it said, and why. */
export type Drop = { slot: string; text: string; reason: string }

/** What the checks did to one answer: what's kept, what's dropped and what may be asked again. */
export type Checked<T> = { value: T; dropped: Drop[]; banned: Drop[] }

type Judged = { slot: string; text: string; verdict: Verdict }

function tally<T>(value: T, judged: Judged[]): Checked<T> {
  const out: Checked<T> = { value, dropped: [], banned: [] }
  for (const { slot, text, verdict: v } of judged) {
    if ('dropped' in v) out.dropped.push({ slot, text, reason: v.dropped })
    if ('banned' in v) out.banned.push({ slot, text, reason: v.banned })
  }
  return out
}

type EvalSentences = Pick<EvalInsight, 'answer' | 'findings' | 'rows' | 'namedTools'>

/**
 * A choose eval's tool counts, as the layout prints them: under a fact's path, the counted tries
 * whose kept named tools include the tool (case aside), over the counted tries. The names are
 * every tool the model named, kept or not, and the subject, so a tool it named wrongly or never
 * counts 0.
 */
function toolCounts(
  output: InsightsOutput,
  input: InsightInput,
  kept: Array<{ attempt: string; tools: string[] }>,
  texts: Map<string, string>,
): NonNullable<Citable['tools']> {
  const subject = input.intent?.subject.tool
  const names = [
    ...new Set(
      [...output.namedTools.flatMap((n) => n.tools), ...(subject ? [subject] : [])]
        .map(oneLine)
        .filter(Boolean),
    ),
  ].sort((a, b) => b.length - a.length)
  const named = new Map(kept.map((n) => [n.attempt, new Set(n.tools.map((t) => t.toLowerCase()))]))
  const attempts = [...texts.keys()]
  return {
    names,
    count: (tool, cite) => {
      const under = attempts.filter(
        (a) => a === cite || a.startsWith(`${cite}#`) || a.startsWith(`${cite}/`),
      )
      if (!under.length) return null
      const n = under.filter((a) => named.get(a)?.has(tool.toLowerCase())).length
      return `${n} of ${under.length}`
    },
  }
}

/**
 * An eval's insights call, checked. `texts` holds each attempt's whole final message, which a
 * named tool must appear in verbatim. Each drop's slot names the eval and where the sentence was
 * going: `answer`, `finding 2`, `row <path under the eval>` or `named tools <attempt>`.
 */
export function validateEvalInsights(
  output: InsightsOutput,
  input: InsightInput,
  slots: InsightSlots,
  texts: Map<string, string>,
): Checked<EvalSentences> {
  const judged: Judged[] = []
  const under = (path: string) =>
    path.startsWith(`${input.eval.path}/`) ? path.slice(input.eval.path.length + 1) : path
  const slot = (where: string) => `${input.eval.name} › ${where}`
  const drop = (where: string, text: string, reason: string) =>
    judged.push({ slot: slot(where), text, verdict: { dropped: reason } })
  const namedTools = output.namedTools.flatMap((n) => {
    const where = `named tools ${under(n.attempt)}`
    if (!slots.namedTools) {
      drop(where, n.tools.join(', '), "isn't on a choose eval")
      return []
    }
    const text = texts.get(n.attempt)
    if (text === undefined) {
      drop(where, n.tools.join(', '), "isn't an attempt it was shown")
      return []
    }
    const tools = [...new Set(n.tools.map(oneLine).filter(Boolean))].filter((t) => {
      if (new RegExp(`(?<!\\w)${escapeRegExp(t)}(?!\\w)`).test(text)) return true
      drop(where, t, "isn't in the attempt's final message")
      return false
    })
    return tools.length ? [{ attempt: n.attempt, tools }] : []
  })
  const c: Citable = {
    ...citableEval(input),
    ...(slots.namedTools ? { tools: toolCounts(output, input, namedTools, texts) } : {}),
  }
  const keep = (s: Sentence, where: string, max = 1) => {
    const v = checkSentence(s, c, max)
    judged.push({ slot: slot(where), text: s.text, verdict: v })
    return 'ok' in v ? v.ok : null
  }
  const answer = output.answer ? keep(output.answer, 'answer', 2) : null
  const open = new Set(slots.rows)
  const filled = new Set<string>()
  const rows = output.rows.flatMap((r) => {
    const where = `row ${under(r.row)}`
    if (!open.has(r.row)) {
      drop(where, r.text, "isn't a row this eval's layout takes a sentence on")
      return []
    }
    if (filled.has(r.row)) {
      drop(where, r.text, 'is a second sentence on the row')
      return []
    }
    const kept = keep(r, where)
    if (!kept) return []
    filled.add(r.row)
    return [{ ...kept, row: r.row }]
  })
  const shown = new Set(
    [answer?.text, ...(answer ? sentencesOf(answer.text) : []), ...rows.map((r) => r.text)]
      .filter((t): t is string => !!t)
      .map(sameText),
  )
  let findingsKept = 0
  const findings = output.findings.flatMap((s, i) => {
    if (!slots.findings) {
      drop(`finding ${i + 1}`, s.text, "this eval's layout has no findings")
      return []
    }
    if (shown.has(sameText(s.text))) {
      drop(`finding ${i + 1}`, s.text, 'repeats a sentence already shown')
      return []
    }
    if (findingsKept === MAX_FINDINGS) {
      drop(`finding ${i + 1}`, s.text, `is past the ${MAX_FINDINGS} findings an eval takes`)
      return []
    }
    const kept = keep(s, `finding ${i + 1}`)
    if (kept) {
      shown.add(sameText(kept.text))
      findingsKept++
    }
    return kept ? [kept] : []
  })
  return tally(
    {
      answer,
      findings,
      ...(rows.length ? { rows } : {}),
      ...(namedTools.length ? { namedTools } : {}),
    },
    judged,
  )
}

const EVAL_COUNT = new RegExp(
  String.raw`\b(\d+|${NUMBER_WORDS.join('|')})\s+(?:[a-z-]+\s+)?evals?\b`,
  'gi',
)

/**
 * Why a headline calls a tally number a count of evals, or undefined. The tally counts results
 * (each case of a family is one), so "22 evals" on a run of 13 evals is false.
 */
function evalMiscount(text: string, input: HeadlineInput): string | undefined {
  const evals = input.evals.length
  const { unit: _, ...counts } = input.tally
  const tallied = new Set(Object.values(counts))
  for (const [, raw = ''] of text.matchAll(EVAL_COUNT)) {
    const word = NUMBER_WORDS.indexOf(raw.toLowerCase())
    const n = word >= 0 ? word : Number(raw)
    if (n !== evals && tallied.has(n)) {
      return `says ${raw} evals, but the run has ${evals}; the tally counts results, not evals`
    }
  }
  return undefined
}

export function validateHeadline(
  output: HeadlineOutput,
  input: HeadlineInput,
): Checked<Sentence | null> {
  if (!output.headline) return { value: null, dropped: [], banned: [] }
  const checked = checkSentence(output.headline, citableHeadline(input))
  const miscounted = 'ok' in checked ? evalMiscount(checked.ok.text, input) : undefined
  const v: Verdict = miscounted ? { dropped: miscounted } : checked
  return tally('ok' in v ? v.ok : null, [
    { slot: 'headline', text: output.headline.text, verdict: v },
  ])
}
