// Checks a model's analysis against its digest: citations must name something in it, quotes must be
// in the cited evidence, numbers should be in the cited facts (anomalies included), a cited judge
// score must match the recorded one or the line is dropped, and verify commands must parse as
// reeval's own CLI and, for `reeval run`, select an eval of the run. What fails is dropped (or, for
// other numbers, flagged), and counted in `validation`.
import { checkCommand, type SelectableEval } from '../cli-spec.ts'
import type {
  AnalysisAction,
  AnalysisAnomaly,
  AnalysisBody,
  AnalysisClaim,
  AnalysisValidation,
  Confidence,
} from '../view/analysis.ts'
import { citable, type Digest } from './digest.ts'
import type { AnalysisOutput } from './schema.ts'

const CHECK = /^(.+):check(\d+)$/
const LINE = /^(E\d+):L(\d+)$/
const TRANSCRIPT = /^transcript:(.+)#L(\d+)$/

const normal = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
const NUMBER = /(?<![\w.#/:-])[−-]?\d+(?:\.\d+)?(?![\w/])/g

/** A digest's citation checker: whether an id is valid, and the text it names. */
export function citations(digest: Digest) {
  const { ids, lines } = citable(digest)
  const factText = new Map(digest.facts.map((f) => [f.id, JSON.stringify(f)]))
  const evidenceText = new Map(digest.evidence.map((e) => [e.id, e.lines.join('\n')]))
  const evidenceOf = (attempt: string) =>
    digest.evidence.filter((e) => e.ref.endsWith(`:${attempt}`)).map((e) => e.id)
  /** The text a citation names, or null when it names nothing in the digest. */
  const resolve = (cite: string): string | null => {
    const c = cite.trim().replace(/^\[|\]$/g, '')
    if (ids.has(c)) {
      return factText.get(c) ?? evidenceText.get(c) ?? JSON.stringify(digest.attempts[c])
    }
    const line = LINE.exec(c)
    if (line) {
      const [, id, n] = line as unknown as [string, string, string]
      if (!lines.get(id)?.has(Number(n))) return null
      return (
        digest.evidence.find((e) => e.id === id)?.lines.find((l) => l.startsWith(`L${n} `)) ?? null
      )
    }
    const transcript = TRANSCRIPT.exec(c)
    if (transcript) {
      const [, attempt, n] = transcript as unknown as [string, string, string]
      for (const id of evidenceOf(attempt)) {
        if (lines.get(id)?.has(Number(n))) return resolve(`${id}:L${n}`)
      }
      return null
    }
    const check = CHECK.exec(c)
    if (check) {
      const [, attempt, n] = check as unknown as [string, string, string]
      const a = digest.attempts[attempt]
      return a && Number(n) >= 1 && Number(n) <= a.checks ? JSON.stringify(a) : null
    }
    return null
  }
  return { resolve }
}

const ANY_NUMBER = /[−-]?\d+(?:\.\d+)?/g
const FRACTION = /(\d+)\/(\d+)/g
const ATTEMPT_CITE = /:check\d+$|:L\d+$/

/** A decimal in [0, 1]: the form a judge score or threshold takes in the digest. */
const looksLikeScore = (raw: string) => {
  if (!raw.includes('.')) return false
  const n = Number(raw.replace('−', '-'))
  return n >= 0 && n <= 1
}

const addScore = (scores: number[], n: unknown) => {
  if (typeof n === 'number' && Number.isFinite(n)) scores.push(n)
}

/**
 * Recorded judge scores (and thresholds) on the cited attempt, fact or evidence. The digest stores
 * them as `attempt.judge`, `judge: { score, threshold }` on a failure, and `judge score:` lines.
 */
function citedJudgeScores(cites: string[], digest: Digest): number[] {
  const scores: number[] = []
  for (const cite of cites) {
    const id = cite
      .trim()
      .replace(/^\[|\]$/g, '')
      .replace(ATTEMPT_CITE, '')
    addScore(scores, digest.attempts[id]?.judge)
    const fact = digest.facts.find((f) => f.id === id)
    if (fact) {
      const j = fact.judge
      if (typeof j === 'number') addScore(scores, j)
      else if (j && typeof j === 'object') {
        addScore(scores, (j as { score?: unknown }).score)
        addScore(scores, (j as { threshold?: unknown }).threshold)
      }
      if (Array.isArray(fact.failures)) {
        for (const row of fact.failures) {
          if (row && typeof row === 'object') addScore(scores, (row as { score?: unknown }).score)
        }
      }
      if (Array.isArray(fact.threshold)) for (const t of fact.threshold) addScore(scores, t)
    }
    const evidence = digest.evidence.find((e) => e.id === id)
    if (evidence) {
      for (const line of evidence.lines) {
        const score = /judge score:\s*([−-]?\d+(?:\.\d+)?)/i.exec(line)
        if (score) addScore(scores, Number((score[1] as string).replace('−', '-')))
        const threshold = /threshold\s+([−-]?\d+(?:\.\d+)?)/i.exec(line)
        if (threshold) addScore(scores, Number((threshold[1] as string).replace('−', '-')))
      }
    }
  }
  return scores
}

/**
 * Numbers in `text` that none of `sources` contains: within rounding, as a percentage, or as the
 * percentage of a `pass/counted` fraction there.
 */
export function unverifiedNumbers(text: string, sources: string[]): string[] {
  const known = sources.flatMap((s) => [
    ...[...s.matchAll(ANY_NUMBER)].map((m) => Number(m[0].replace('−', '-'))),
    ...[...s.matchAll(FRACTION)].flatMap((m) =>
      Number(m[2]) ? [(100 * Number(m[1])) / Number(m[2]), Number(m[2]) - Number(m[1])] : [],
    ),
  ])
  const close = (n: number) =>
    known.some((k) =>
      [k, k * 100, k / 100, -k].some(
        (v) =>
          Math.abs(v - n) <= Math.max(0.01, Math.abs(v) * 0.01) ||
          Math.round(v) === n ||
          Math.round(v * 10) / 10 === n,
      ),
    )
  return [...new Set([...text.matchAll(NUMBER)].map((m) => m[0]))].filter((raw) => {
    const n = Number(raw.replace('−', '-'))
    if (Number.isInteger(n) && Math.abs(n) <= 5) return false
    return !close(n)
  })
}

/**
 * After citation and command checks, the model's overall rating cannot stay `high` when any
 * check failed, and a dropped claim or rejected command is `low`. The model never sees these
 * counts, so it cannot self-rate them.
 */
export function capConfidence(
  overall: Confidence,
  validation: Pick<AnalysisValidation, 'invalid' | 'dropped' | 'invalidCommands'>,
): Confidence {
  if (validation.dropped > 0 || validation.invalidCommands.length > 0) return 'low'
  if (validation.invalid.length > 0 && overall === 'high') return 'medium'
  return overall
}

export function validateAnalysis(
  output: AnalysisOutput,
  digest: Digest,
  tables: readonly string[],
  evals?: readonly SelectableEval[],
): { body: AnalysisBody; validation: AnalysisValidation } {
  const { resolve } = citations(digest)
  const validation: AnalysisValidation = {
    citations: 0,
    invalid: [],
    dropped: 0,
    commands: 0,
    invalidCommands: [],
    unverifiedNumbers: 0,
  }
  /** The item's valid citations and their texts; null (and counted) when none is valid. */
  const cited = (where: string, cites: string[]) => {
    const good: string[] = []
    const texts: string[] = []
    for (const c of cites) {
      validation.citations++
      const text = resolve(c)
      if (text === null) validation.invalid.push(`${where}: ${c}`)
      else {
        good.push(c.trim().replace(/^\[|\]$/g, ''))
        texts.push(text)
      }
    }
    if (good.length === 0) {
      validation.dropped++
      return null
    }
    return { good, texts }
  }
  /**
   * Unverified numbers, or null when a cited judge score disagrees: that line cannot keep a
   * wrong score in the written explanation.
   */
  const numbersOrDrop = (where: string, text: string, cites: string[], texts: string[]) => {
    const numbers = unverifiedNumbers(text, [...texts, ...digest.rules])
    validation.unverifiedNumbers += numbers.length
    const recorded = citedJudgeScores(cites, digest)
    const wrong = recorded.length ? numbers.filter(looksLikeScore) : []
    if (!wrong.length) return numbers
    const shown = [...new Set(recorded.map(String))].join(', ')
    validation.invalid.push(`${where}: ${wrong.join(', ')} isn't the cited judge score (${shown})`)
    validation.dropped++
    return null
  }
  const claims = (where: string, items: AnalysisOutput['whatHappened']): AnalysisClaim[] =>
    items.flatMap((item, i) => {
      const c = cited(`${where}[${i}]`, item.cites)
      if (!c) return []
      const haystack = normal(c.texts.join('\n'))
      const invented = (item.quotes ?? []).find((quote) => !haystack.includes(normal(quote)))
      if (invented !== undefined) {
        validation.invalid.push(
          `${where}[${i}]: "${invented.slice(0, 120)}" isn't in the cited evidence`,
        )
        validation.dropped++
        return []
      }
      const numbers = numbersOrDrop(`${where}[${i}]`, item.text, c.good, c.texts)
      if (!numbers) return []
      return [
        {
          text: item.text,
          cites: c.good,
          confidence: item.confidence,
          ...(item.quotes?.length ? { quotes: item.quotes } : {}),
          ...(numbers.length ? { unverifiedNumbers: numbers } : {}),
        },
      ]
    })
  const whatHappened = claims('whatHappened', output.whatHappened)
  const results = claims('results', output.results)
  const why = claims('why', output.why)
  const anomalies: AnalysisAnomaly[] = output.anomalies.flatMap((a, i) => {
    const c = cited(`anomalies[${i}]`, a.cites)
    if (!c) return []
    const numbers = numbersOrDrop(`anomalies[${i}]`, a.text, c.good, c.texts)
    if (!numbers) return []
    return [
      {
        text: a.text,
        kind: a.kind,
        cites: c.good,
        ...(numbers.length ? { unverifiedNumbers: numbers } : {}),
      },
    ]
  })
  const actions: AnalysisAction[] = output.actions.flatMap((a, i) => {
    const c = cited(`actions[${i}]`, a.cites)
    if (!c) return []
    const verify = a.verify.trim().replace(/^`+|`+$/g, '')
    validation.commands++
    const problem = verify ? checkCommand(verify, tables, evals) : 'no command'
    if (problem) validation.invalidCommands.push(`${verify}: ${problem}`)
    return [
      {
        title: a.title,
        target: a.target,
        kind: a.kind,
        change: a.change,
        expectedEffect: a.expectedEffect,
        verify: problem ? null : verify,
        ...(problem ? { verifyProblem: `${verify}: ${problem}` } : {}),
        impact: a.impact,
        effort: a.effort,
        cites: c.good,
      },
    ]
  })
  return {
    body: {
      tldr: output.tldr,
      whatHappened,
      results,
      why,
      anomalies,
      actions,
      confidence: {
        overall: capConfidence(output.confidence.overall, validation),
        why: output.confidence.why,
      },
    },
    validation,
  }
}
