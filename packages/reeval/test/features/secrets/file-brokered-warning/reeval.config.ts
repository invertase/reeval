import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker only: the fake sandbox has no gateway to broker the secrets. REEVAL_SECRETS_FILE brokers
// API_KEY to REEVAL_EGRESS_HOST, the listener features.test.ts starts, and OTHER_KEY to
// api.example.com.
export default defineConfig({
  // As the agent: print API_KEY, then send both placeholders to the listener over plain HTTP.
  harnesses: fakeHarness({
    script: [
      [
        {
          exec: `printenv API_KEY; curl -sS -m 10 "http://${process.env.REEVAL_EGRESS_TARGET}/?k=$API_KEY" -H "X-Other: $OTHER_KEY"`,
        },
      ],
    ],
  }),
})
