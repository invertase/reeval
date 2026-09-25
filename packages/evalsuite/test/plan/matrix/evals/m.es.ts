import { evaluate, group } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'

group('grouped', { runs: 2 }, () => {
  evaluate('inherits runs', async () => {})
  evaluate('own runs', { runs: 3 }, async () => {})
})
evaluate('added harness', { harness: (h) => [...h, fakeHarness({ id: 'c' })] }, async () => {})
evaluate('replaced harness', { harness: fakeHarness({ id: 'c' }) }, async () => {})
