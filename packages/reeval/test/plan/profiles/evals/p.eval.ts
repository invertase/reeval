import { defineEnvironment, evaluate } from 'reeval'
import { fakeHarness } from 'reeval/harness'

const skilled = defineEnvironment('skilled', { env: { MODE: 'x' } })

evaluate('plain', { runs: 3 }, async () => {})
evaluate('compared', { compare: { variants: [skilled] } }, async () => {})
evaluate('regression', { compare: { variants: [skilled] }, runs: 2, pin: ['compare', 'runs'] }, async () => {})
evaluate('own harness', { harness: fakeHarness({ id: 'b' }) }, async () => {})
evaluate('slow', { tags: ['nightly-only'] }, async () => {})
