import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker only: reeval looks for the processes setup left running in the container.
export default defineConfig({
  // As the agent: CHECK_TOKEN in any process's environment, as `value` or `placeholder`.
  harnesses: fakeHarness({
    script: [
      [
        {
          exec: String.raw`for e in /proc/[0-9]*/environ; do tr '\0' '\n' < "$e" 2>/dev/null | grep '^CHECK_TOKEN='; done | sed -E 's/^CHECK_TOKEN=reeval_secret_.*/placeholder/; t; s/^CHECK_TOKEN=.*/value/' | sort -u | tr '\n' ' '`,
        },
      ],
    ],
  }),
})
