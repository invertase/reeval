import { evaluate, group } from 'reeval'
import { base, skilled, terse } from './envs.ts'

// Each eval in the group asks its questions; one that sets its own replaces the list, and [] clears it.
group(
  'asked by the group',
  {
    compare: { baseline: base, variants: [skilled] },
    questions: [
      { question: 'Which handles state more cleanly?', across: 'environment', diff: true },
    ],
  },
  () => {
    evaluate('inherits the question', async () => {})
    evaluate('also inherits it', { runs: 2, gate: { passRate: 0.5 } }, async () => {})
    evaluate(
      'replaces the compare',
      { compare: { baseline: base, variants: [terse] } },
      async () => {},
    )
    evaluate(
      'replaces the questions',
      { questions: [{ question: 'What did the agent change?', diff: true }] },
      async () => {},
    )
    evaluate('asks none', { questions: [] }, async () => {})
  },
)
// A skipped eval asks nothing, so the pairwise question it inherits needs nothing to vary.
group(
  "pairs its evals' compares",
  { questions: [{ question: 'Which is shorter?', across: 'environment', diff: true }] },
  () => {
    evaluate('compares', { compare: { baseline: base, variants: [skilled] } }, async () => {})
    evaluate.skip('skipped without a compare', async () => {})
  },
)
