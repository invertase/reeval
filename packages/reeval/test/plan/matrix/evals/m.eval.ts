import { evaluate, group } from 'reeval'
import { fakeHarness } from 'reeval/harness'

group('grouped', { runs: 2 }, () => {
  evaluate('inherits runs', async () => {})
  evaluate('own runs', { runs: 3 }, async () => {})
})
evaluate('added harness', { harness: (h) => [...h, fakeHarness({ id: 'c' })] }, async () => {})
evaluate('replaced harness', { harness: fakeHarness({ id: 'c' }) }, async () => {})
evaluate('gated on a pass rate', { runs: 5, gate: { passRate: 0.8 } }, async () => {})
