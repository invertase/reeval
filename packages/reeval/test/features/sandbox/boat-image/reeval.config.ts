import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

const target = `http://${process.env.REEVAL_EGRESS_TARGET}/`

// Docker tier only: boat() with an image recipe on the fake Boat API, whose saved snapshots' VMs
// run their containers on the host's Docker. As the agent: what the recipe baked, who runs the
// shell, and the host's listener reached directly, around the proxy, then through it.
export default defineConfig({
  harnesses: fakeHarness({
    script: [
      [
        {
          exec: `cat /etc/reeval-recipe; id -un; curl -s -m 5 -o /dev/null -w '%{http_code}' --noproxy '*' ${target}; echo " exit=$?"; curl -s -m 10 -o /dev/null -w '%{http_code}' ${target}; echo`,
        },
      ],
    ],
  }),
})
