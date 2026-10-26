import { evaluate } from 'reeval'
import { base, skilled } from './envs.ts'

const compare = { baseline: base, variants: [skilled] }

evaluate('one run a cell can never get a verdict', { compare, runs: 1 }, async () => {})
evaluate('three runs a cell can never get a verdict', { compare, runs: 3 }, async () => {})
evaluate('four runs a cell can', { compare, runs: 4 }, async () => {})
evaluate.each(['ada', 'grace', 'linus'])(
  'three cases can never get a verdict: %s',
  { compare, runs: 4 },
  async () => {},
)
evaluate.each(['a', 'b', 'c', 'd', 'e', 'f'])('six cases can: %s', { compare }, async () => {})
