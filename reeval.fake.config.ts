import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'

// The same evals with no keys: an agent that changes nothing, so every eval's checks must fail.
export default defineConfig({
  harness: fakeHarness({ text: 'Done.' }),
  sandbox: fakeSandbox(),
  judge: { model: fakeJudge({ score: 0.9 }) },
})
