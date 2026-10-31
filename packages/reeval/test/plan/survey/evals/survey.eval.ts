import { defineEnvironment, evaluate, survey } from 'reeval'

const base = defineEnvironment('base', { env: { MODE: 'base' } })
const skilled = base.extendEnvironment('skilled', { env: { MODE: 'skilled' } })

// Every cell ran, none gated, and no pass^k hint however many runs.
survey('which database', { runs: 3 }, async () => {})
survey(
  'which database with the skill',
  { compare: { control: base, variants: [skilled] }, runs: 4 },
  async () => {},
)
survey('which framework', { cases: ['chat', 'rag'] }, async () => {})
evaluate('ungated on its own', { gate: 'none', runs: 2 }, async () => {})
