import { evaluate } from 'reeval'
import { base, skilled } from './envs.ts'

const compare = { control: base, variants: [skilled] }

evaluate('one run a cell can never get a verdict', { compare, runs: 1 }, async () => {})
evaluate('three runs a cell can never get a verdict', { compare, runs: 3 }, async () => {})
evaluate('four runs a cell can', { compare, runs: 4 }, async () => {})
evaluate(
  'three cases can never get a verdict',
  { cases: ['ada', 'grace', 'linus'], compare, runs: 4 },
  async () => {},
)
evaluate('six cases can', { cases: ['a', 'b', 'c', 'd', 'e', 'f'], compare }, async () => {})
