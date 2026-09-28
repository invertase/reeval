import { defineEnvironment, evaluate } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'

const skilled = defineEnvironment('skilled', { env: { MODE: 'x' } })

evaluate('plain', { runs: 3 }, async () => {})
evaluate('compared', { compare: [skilled] }, async () => {})
evaluate('regression', { compare: [skilled], runs: 2, pin: ['compare', 'runs'] }, async () => {})
evaluate('own harness', { harness: fakeHarness({ id: 'b' }) }, async () => {})
evaluate('slow', { tags: ['nightly-only'] }, async () => {})
