import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker tier only: daytona({ from, install }) on the fake Daytona API, which builds the image
// reeval generates and starts each sandbox from its snapshot, logging in as root; both attempts
// share one machine, each slot restoring the image's copy of the home. The bootstrap
// says whether it ran in the image, before the install, or in the attempt, after it. As the agent:
// who it is, what the install left, which node it finds, and where the bootstrap ran.
export default defineConfig({
  harnesses: fakeHarness({
    bootstrap:
      'if [ -f /etc/reeval-install-proof ]; then echo attempt; else echo image; fi > ~/bootstrapped',
    script: [
      [
        {
          exec: 'id -un; cat /etc/reeval-install-proof; command -v node; cat ~/bootstrapped',
        },
      ],
    ],
  }),
})
