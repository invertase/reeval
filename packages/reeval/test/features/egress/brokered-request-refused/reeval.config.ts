import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker only: the fake sandbox has no gateway to broker the key.
export default defineConfig({
  // As the agent: send Codex's brokered key to a path on its API that reeval doesn't broker it
  // for, as Codex sends a web search. The gateway refuses it before anything goes upstream.
  harness: fakeHarness({
    layout: 'codex',
    brokers: true,
    script: [
      [
        {
          exec: 'curl -sS -m 20 -X POST https://api.openai.com/v1/alpha/search -H "Authorization: Bearer $OPENAI_API_KEY" -d "{}"',
        },
      ],
    ],
  }),
})
