import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
// The first turn fails as an outage would; the second as Anthropic out of credit would.
export default defineConfig({
  harnesses: fakeHarness({
    script: [
      [{ error: '503 Service Unavailable: overloaded' }],
      [{ error: 'Your credit balance is too low to access the Anthropic API.' }],
    ],
  }),
})
