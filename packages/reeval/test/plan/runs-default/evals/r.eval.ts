import { defineEnvironment, evaluate, group } from 'reeval'

const base = defineEnvironment('base', { env: { MODE: 'base' } })
const skilled = base.extendEnvironment('skilled', { env: { MODE: 'skilled' } })

// Unset runs: a compare runs 4 a side, anything else once; any level that sets runs wins.
evaluate('compare', { compare: { control: base, variants: [skilled] } }, async () => {})
evaluate(
  'compare with runs 1',
  { runs: 1, compare: { control: base, variants: [skilled] } },
  async () => {},
)
group('runs from the group', { runs: 2 }, () => {
  evaluate('compare', { compare: { control: base, variants: [skilled] } }, async () => {})
})
evaluate('no compare', { environments: base }, async () => {})
