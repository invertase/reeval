// A rule-based stand-in for the insight model, for `fakeAnalysis({ insights })`: it reads the facts
// each call is given and writes the sentences a model would, citing them, so the recipe's
// insights go through the same validator with no key. It knows the tools the choose eval names.
import type { FakeInsights, FakeInsightsInput } from 'reeval/judge'

const TOOLS = ['Genkit', 'LangChain', 'LlamaIndex', 'Mastra']

type Fact = { path: string; kind: string } & Record<string, unknown>
type EvalCall = Exclude<FakeInsightsInput, { call: 'headline' }>

const str = (x: unknown) => (typeof x === 'string' ? x : '')

/** `0 of 2 passed` → `0 of 2`. */
const countOf = (f: Fact) => str(f.result).replace(/ passed$/, '')

const failing = (f: Fact) =>
  f.kind === 'check' && /^\d+ of \d+ passed$/.test(str(f.result)) && !/^(\d+) of \1 /.test(str(f.result))

/** The facts under one case or cell: those after it, up to the next of its kind. */
function under(facts: Fact[], path: string): Fact[] {
  const i = facts.findIndex((f) => f.path === path)
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
function rowSentence(input: EvalCall, path: string): { text: string; cites: string[] } | null {
  const fact = input.facts.find((f) => f.path === path)
  if (!fact) return null
  if (fact.kind === 'all cases') {
    return { text: `${str(fact.arm)} ${str(fact.effect)} across all the cases.`, cites: [path] }
  }
  if (fact.kind === 'cell' && (fact.effect === 'helped' || fact.effect === 'made it worse')) {
    return {
      text: `${str(fact.arm)} ${str(fact.effect)}: ${str(fact.passed)} passed.`,
      cites: [path],
    }
  }
  const check = under(input.facts, path).find(failing)
  if (check) {
    const others = input.attempts
      .filter((a) => a.cell.startsWith(path) || check.path.startsWith(a.cell))
      .flatMap((a) => TOOLS.filter((t) => t !== input.intent?.subject.tool && a.lastText.includes(t)))
    const [other] = new Set(others)
    return other
      ? { text: `It also names ${other}, so "${str(check.label)}" fails.`, cites: [path, check.path] }
      : { text: `Only ${countOf(check)} passed "${str(check.label)}".`, cites: [check.path] }
  }
  if (Array.isArray(fact.errors) && fact.errors.length) {
    return { text: 'An infra error stopped it before any check ran.', cites: [path] }
  }
  return null
}

function answer(input: EvalCall): { text: string; cites: string[] } {
  const own = input.eval.path
  const cases = input.facts.filter((f) => f.kind === 'case')
  if (cases.length) {
    const missed = cases.filter((k) => k.verdict !== 'pass')
    const [first] = missed
    if (!first) return { text: `Yes: all ${cases.length} cases pass.`, cites: [own] }
    return {
      text: `Not for ${str(first.label)}: ${str(first.passed)} passed.`,
      cites: [first.path],
    }
  }
  if (input.eval.verdict === 'pass') return { text: 'Yes: every try passed.', cites: [own] }
  const cell = input.facts.find((f) => f.kind === 'cell' && f.verdict !== 'pass')
  const check = cell ? under(input.facts, cell.path).find(failing) : undefined
  const who =
    cell && input.eval.across === 'harness'
      ? ` on ${str(cell.harness)}`
      : cell && input.eval.across !== 'none'
        ? ` with ${str(cell.arm)}`
        : ''
  if (check) {
    return {
      text: `No: only ${countOf(check)} passed "${str(check.label)}"${who}.`,
      cites: [check.path],
    }
  }
  return { text: `No: it never finished${who}.`, cites: [cell?.path ?? own] }
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
      cites: [moved.path, base.path],
    },
  ]
}

/** What the fake insight model answers to each call. */
export function insights(input: FakeInsightsInput): FakeInsights {
  if (input.call === 'headline') {
    const missed = input.evals.filter((e) => e.verdict !== 'pass')
    const [first] = missed
    if (!first) {
      return { headline: { text: 'Every eval passes.', cites: input.evals.map((e) => e.path) } }
    }
    return {
      headline: {
        text: `${input.tally.fail} fail; start with "${first.name}".`,
        cites: [first.path],
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
