import { defineEnvironment, evaluate } from 'reeval'
import { fakeHarness } from 'reeval/harness'

const plain = defineEnvironment('plain', {})
const skilled = defineEnvironment('skilled', { env: { MODE: 'x' } })

evaluate('plain', { runs: 3 }, async () => {})
evaluate('compared', { compare: { control: plain, variants: [skilled] } }, async () => {})
evaluate(
  'regression',
  { compare: { control: plain, variants: [skilled] }, runs: 2, pin: ['compare', 'runs'] },
  async () => {},
)
evaluate('own harness', { harnesses: fakeHarness({ id: 'b' }) }, async () => {})
evaluate('slow', { tags: ['nightly-only'] }, async () => {})
