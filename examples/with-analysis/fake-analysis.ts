// A stand-in for the analysis model: it answers from the facts each call is given and cites them
// by id, as a model must, so its sentences go through reeval's checks with no key.
import type { FakeInsights, FakeInsightsInput } from 'reeval/judge'

type Digest = { facts: { id: string; kind: string; cells?: { pass: string }[] }[] }

/** The run's insights: what each eval asks, its answer, and a headline over the run. */
export function insights(input: FakeInsightsInput): FakeInsights {
  if (input.call === 'classify') {
    return { intent: { job: 'finish', question: 'Does the agent add a tested multiply?' } }
  }
  if (input.call === 'headline') {
    const text = input.tally.fail === 0 ? 'Every eval passed.' : 'Some evals failed.'
    return { headline: { text, cites: input.evals.map((e) => e.id) } }
  }
  const cell = input.facts.find((f) => f.kind === 'cell')
  if (!cell) return { answer: null }
  const text =
    cell.verdict === 'pass' ? 'Yes: the agent added it and the tests pass.' : 'Not on every try.'
  return { answer: { text, cites: [cell.id] } }
}

/** `reeval analyze`'s answer: a TL;DR and one result, citing the digest's pass@1 fact. */
export function output(digest: Digest) {
  const pass = digest.facts.find((f) => f.kind === 'pass@1')
  const all = pass?.cells?.every((c) => c.pass.split('/')[0] === c.pass.split('/')[1])
  const text = all ? 'The agent adds a tested multiply on every try.' : 'Some tries fail.'
  return {
    tldr: text,
    whatHappened: [],
    results: pass ? [{ text, cites: [pass.id], confidence: 'high' }] : [],
    why: [],
    anomalies: [],
    actions: [],
    confidence: { overall: 'medium', why: 'A few attempts, on a fake agent.' },
  }
}
