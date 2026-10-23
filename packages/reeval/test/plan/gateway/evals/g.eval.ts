import { evaluate } from 'reeval'
import { direct } from 'reeval/gateway'
import { fakeHarness } from 'reeval/harness'

evaluate('greets', async () => {})
evaluate('pinned', { harness: fakeHarness({ id: 'b', gateway: direct() }) }, async () => {})
