import { defineEnvironment, evaluate } from 'reeval'

const base = defineEnvironment('base', { env: { MODE: 'base' } })
const skilled = base.extendEnvironment('skilled', { env: { MODE: 'skilled' } })

// Every cell ran, none gated, and no pass^k hint however many runs.
evaluate('which database', { gate: 'observe', runs: 3 }, async () => {})
evaluate(
  'which database with the skill',
  { compare: { control: base, variants: [skilled] }, gate: 'observe', runs: 4 },
  async () => {},
)
evaluate('which framework', { cases: ['chat', 'rag'], gate: 'observe' }, async () => {})
evaluate(
  'the compare observes',
  { compare: { control: base, variants: [skilled], gate: 'observe' }, runs: 2 },
  async () => {},
)
