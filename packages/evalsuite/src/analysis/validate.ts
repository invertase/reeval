// Checks a model's analysis against its digest: citations must name something in it, quotes must be
// in the cited evidence, numbers should be in the cited facts, and verify commands must parse as
// ES's own CLI. What fails is dropped (or, for numbers, flagged), and counted in `validation`.
import { checkCommand } from '../cli-spec.ts'
import type {
  AnalysisAction,
  AnalysisAnomaly,
  AnalysisBody,
  AnalysisClaim,
  AnalysisValidation,
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

export function validateAnalysis(
  output: AnalysisOutput,
  digest: Digest,
  tables: readonly string[],
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
      const numbers = unverifiedNumbers(item.text, [...c.texts, ...digest.rules])
      validation.unverifiedNumbers += numbers.length
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
    return c ? [{ text: a.text, kind: a.kind, cites: c.good }] : []
  })
  const actions: AnalysisAction[] = output.actions.flatMap((a, i) => {
    const c = cited(`actions[${i}]`, a.cites)
    if (!c) return []
    const verify = a.verify.trim().replace(/^`+|`+$/g, '')
    validation.commands++
    const problem = verify ? checkCommand(verify, tables) : 'no command'
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
      confidence: output.confidence,
    },
    validation,
  }
}
