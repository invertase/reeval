import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker only: the fake sandbox has no gateway to broker the key.
export default defineConfig({
  // As the agent: send Codex's brokered key to a path on its API that reeval doesn't broker it
  // for. The gateway answers the refusal itself: nothing goes upstream, only the host's name is
  // resolved.
  harnesses: fakeHarness({
    layout: 'codex',
    brokers: true,
    script: [
      [
        {
          exec: `curl -sS -m 20 'https://api.openai.com/v1/models?limit=1' -H "Authorization: Bearer $OPENAI_API_KEY"`,
        },
      ],
    ],
  }),
})
