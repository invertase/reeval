// A rule-based stand-in for the insight model, for `fakeAnalysis({ insights })`: it reads the facts
// each call is given and writes the sentences a model would, citing them, so the recipe's
// insights go through the same validator with no key. It cites facts by the short ids (`F1`) it's
// shown, as a model does. It knows the tools the choose eval names.
import type { FakeInsights, FakeInsightsInput } from 'reeval/judge'

const TOOLS = ['Genkit', 'LangChain', 'LlamaIndex', 'Mastra']

type Fact = { id: string; path: string; kind: string } & Record<string, unknown>
type EvalCall = Exclude<FakeInsightsInput, { call: 'headline' }>

const str = (x: unknown) => (typeof x === 'string' ? x : '')

/** `0 of 2 passed` → `0 of 2`. */
const countOf = (f: Fact) => str(f.result).replace(/ passed$/, '')

const failing = (f: Fact) =>
  f.kind === 'check' &&
  /^\d+ of \d+ passed$/.test(str(f.result)) &&
  !/^(\d+) of \1 /.test(str(f.result))

/** The facts under one case or cell: those after it, up to the next of its kind. */
function under(facts: Fact[], id: string): Fact[] {
  const i = facts.findIndex((f) => f.id === id)
  if (i < 0) return []
  const kind = facts[i]?.kind
  const end = facts.findIndex((f, j) => j > i && (f.kind === kind || f.kind === 'case'))
  return facts.slice(i + 1, end < 0 ? undefined : end)
}

function classify(input: EvalCall): FakeInsights {
  const name = input.eval.name
  const tool = TOOLS.find((t) => name.includes(t))
  const arm = input.facts.find((f) => f.kind === 'cell' && f.effect !== undefined)
  const change = arm ? str(arm.arm) : undefined
  if (tool && /^(recommends|chooses|picks)\b/.test(name)) {
    return {
      intent: { job: 'choose', question: `Does the agent pick ${tool}?`, subject: { tool } },
    }
  }
  if (/^explains\b/.test(name)) {
    return { intent: { job: 'other', question: 'Does the agent find the root cause?' } }
  }
  return {
    intent: {
      job: 'finish',
      question: `Does the agent finish: ${name}?`,
      subject: change ? { change } : {},
    },
  }
}

/** One sentence on a row the layout opened: why a case or a try failed, or what a change did. */
function rowSentence(input: EvalCall, id: string): { text: string; cites: string[] } | null {
  const fact = input.facts.find((f) => f.id === id)
  if (!fact) return null
  if (fact.kind === 'all cases') {
    return { text: `${str(fact.arm)} ${str(fact.effect)} across all the cases.`, cites: [id] }
  }
  if (fact.kind === 'cell' && (fact.effect === 'helped' || fact.effect === 'made it worse')) {
    return {
      text: `${str(fact.arm)} ${str(fact.effect)}: ${str(fact.passed)} passed.`,
      cites: [id],
    }
  }
  const check = under(input.facts, id).find(failing)
  if (check) {
    const cellPath = (cell: string) => input.facts.find((f) => f.id === cell)?.path ?? ''
    const others = input.attempts
      .filter(
        (a) => cellPath(a.cell).startsWith(fact.path) || check.path.startsWith(cellPath(a.cell)),
      )
      .flatMap((a) =>
        TOOLS.filter((t) => t !== input.intent?.subject.tool && a.lastText.includes(t)),
      )
    const [other] = new Set(others)
    return other
      ? {
          text: `It also names ${other}, so "${str(check.label)}" fails.`,
          cites: [id, check.id],
        }
      : { text: `Only ${countOf(check)} passed "${str(check.label)}".`, cites: [check.id] }
  }
  if (Array.isArray(fact.errors) && fact.errors.length) {
    return { text: 'An infra error stopped it before any check ran.', cites: [id] }
  }
  return null
}

function answer(input: EvalCall): { text: string; cites: string[] } {
  const own = input.facts[0]?.id ?? ''
  const cases = input.facts.filter((f) => f.kind === 'case')
  if (cases.length) {
    const missed = cases.filter((k) => k.verdict !== 'pass')
    const [first] = missed
    if (!first) return { text: `Yes: all ${cases.length} cases pass.`, cites: [own] }
    return {
      text: `Not for ${str(first.label)}: ${str(first.passed)} passed.`,
      cites: [first.id],
    }
  }
  if (input.eval.verdict === 'pass') return { text: 'Yes: every try passed.', cites: [own] }
  const cell = input.facts.find((f) => f.kind === 'cell' && f.verdict !== 'pass')
  const check = cell ? under(input.facts, cell.id).find(failing) : undefined
  const who =
    cell && input.eval.across === 'harness'
      ? ` on ${str(cell.harness)}`
      : cell && input.eval.across !== 'none'
        ? ` with ${str(cell.arm)}`
        : ''
  if (check) {
    return {
      text: `No: only ${countOf(check)} passed "${str(check.label)}"${who}.`,
      cites: [check.id],
    }
  }
  return { text: `No: it never finished${who}.`, cites: [cell?.id ?? own] }
}

function findings(input: EvalCall): Array<{ text: string; cites: string[] }> {
  if (!input.slots?.findings) return []
  const base = input.facts.find((f) => f.kind === 'cell' && f.baseline === true)
  const moved = input.facts.find(
    (f) => f.kind === 'cell' && (f.effect === 'helped' || f.effect === 'made it worse'),
  )
  if (!moved || !base) return []
  return [
    {
      text: `${str(moved.arm)} ${str(moved.effect)}: ${str(moved.passed)} passed with it, against ${str(base.passed)} on ${str(base.arm)}.`,
      cites: [moved.id, base.id],
    },
  ]
}

/** What the fake insight model answers to each call. */
export function insights(input: FakeInsightsInput): FakeInsights {
  if (input.call === 'headline') {
    const missed = input.evals.filter((e) => e.verdict !== 'pass')
    const [first] = missed
    if (!first) {
      return { headline: { text: 'Every eval passes.', cites: input.evals.map((e) => e.id) } }
    }
    return {
      headline: {
        text: `${input.tally.fail} fail; start with "${first.name}".`,
        cites: [first.id],
      },
    }
  }
  if (input.call === 'classify') return classify(input)
  return {
    answer: answer(input),
    findings: findings(input),
    rows: (input.slots?.rows ?? []).flatMap((row) => {
      const s = rowSentence(input, row)
      return s ? [{ ...s, row }] : []
    }),
    namedTools: input.slots?.namedTools
      ? input.attempts
          .map((a) => ({ attempt: a.id, tools: TOOLS.filter((t) => a.lastText.includes(t)) }))
          .filter((a) => a.tools.length)
      : [],
  }
}
