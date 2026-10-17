import { evaluate } from 'reeval'
import { base, skilled, terse } from './envs.ts'

evaluate(
  'a study: every cell ungated, three runs a cell',
  { compare: { baseline: base, variants: [skilled, terse], gate: 'none' }, runs: 3 },
  async () => {},
)
