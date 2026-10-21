// One eval's input cut to fit a size cap, the same way every time. The sentences need the
// verdicts, cells, failing checks and their messages most, so those always stay; what goes first
// is what they need least: passing attempts' messages, then long transcript excerpts, then
// passing checks and effort, then the rest of the transcripts and messages. `trimmed` names each
// cut, so the model knows the input isn't whole.
import { clip } from '../text.ts'
import type { InsightAttempt, InsightFact, InsightInput } from './input.ts'

/**
 * The largest eval input a call gets, in characters of its JSON (about 4 per token, so about 6k
 * tokens). The biggest on a 104-eval suite was 8.3k characters; the cap leaves three times that,
 * so only an unusually large eval (a wide family, many failing tries with long transcripts) is cut.
 */
export const EVAL_INPUT_CHARS = 24_000

type Input = Omit<InsightInput, 'call'>

const size = (input: Input) => JSON.stringify(input).length

const passing = (a: InsightAttempt) => a.outcome === 'pass'

const passedCheck = (f: InsightFact) =>
  f.kind === 'check' &&
  typeof f.result === 'string' &&
  /^(\d+) of \1 passed$/.test(f.result) &&
  f.effect === undefined

type Step = {
  cut: string
  apply: (input: Input, keep: Set<string>) => Input
}

const attempts = (input: Input, f: (a: InsightAttempt, i: number) => InsightAttempt | null) => ({
  ...input,
  attempts: input.attempts.flatMap((a, i) => f(a, i) ?? []),
})

/** In the order they're applied: each runs only while the input is still over the cap. */
const STEPS: Step[] = [
  {
    cut: "passing attempts' final messages",
    apply: (input) =>
      attempts(input, (a) => (passing(a) ? { ...a, lastText: clip(a.lastText, 300) } : a)),
  },
  {
    cut: 'older transcript lines',
    apply: (input) => attempts(input, (a) => ({ ...a, lines: a.lines.slice(-6) })),
  },
  {
    cut: 'passing checks and effort',
    apply: (input, keep) => ({
      ...input,
      facts: input.facts.filter(
        (f) => keep.has(f.path) || !(passedCheck(f) || f.kind === 'effort'),
      ),
    }),
  },
  {
    cut: "failing attempts' final messages",
    apply: (input) => attempts(input, (a) => ({ ...a, lastText: clip(a.lastText, 400) })),
  },
  {
    cut: 'transcript lines',
    apply: (input) => attempts(input, (a) => ({ ...a, lines: a.lines.slice(-2) })),
  },
  {
    cut: 'passing attempts after the first of each cell',
    apply: (input) => {
      const seen = new Set<string>()
      return attempts(input, (a) => {
        if (!passing(a)) return a
        if (seen.has(a.cell)) return null
        seen.add(a.cell)
        return a
      })
    },
  },
  {
    cut: 'source lines after the first 30',
    apply: (input) =>
      input.source
        ? { ...input, source: { ...input.source, lines: input.source.lines.slice(0, 30) } }
        : input,
  },
  {
    cut: 'prompts',
    apply: (input) => ({ ...input, prompts: input.prompts.map((p) => clip(p, 300)) }),
  },
  {
    cut: 'passing cells',
    apply: (input, keep) => ({
      ...input,
      facts: input.facts.filter(
        (f) => keep.has(f.path) || !(f.kind === 'cell' && f.verdict === 'pass' && !f.effect),
      ),
    }),
  },
]

/**
 * `input` within `maxChars`, cut by `STEPS` in order until it fits; `keep` is the facts that must
 * stay whatever the size (the rows the layout opens a sentence on). What's still over after every
 * step goes as it is: the failing facts are never cut.
 */
export function trimInput(input: Input, maxChars: number, keep: Iterable<string> = []): Input {
  if (size(input) <= maxChars) return input
  const kept = new Set(keep)
  let out = input
  const cuts: string[] = []
  for (const step of STEPS) {
    const next = step.apply(out, kept)
    if (size(next) < size(out)) {
      out = next
      cuts.push(step.cut)
    }
    if (size({ ...out, trimmed: cuts }) <= maxChars) break
  }
  return { ...out, trimmed: cuts }
}
