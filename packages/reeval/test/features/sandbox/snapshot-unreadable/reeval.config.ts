import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker only: the fake sandbox runs on the host as whoever runs reeval, who can read its state.
export default defineConfig({
  // As the agent: whether it can open the snapshot's HEAD.
  harnesses: fakeHarness({
    script: [
      [
        {
          exec: 'cat /var/lib/reeval/workspace.git/HEAD >/dev/null 2>&1 && echo read || echo refused',
        },
      ],
    ],
  }),
})
