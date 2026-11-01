import { evaluate } from 'reeval'
import { base, skilled, terse } from './envs.ts'

evaluate(
  'a study: every cell ungated, three runs a cell',
  { compare: { control: base, variants: [skilled, terse], gate: 'observe' }, runs: 3 },
  async () => {},
)
