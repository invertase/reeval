import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker only: the fake sandbox has no gateway. REEVAL_EGRESS_TARGET is a listener on the host that
// features.test.ts starts, at a non-loopback address, so the fetch leaves only through the proxy.
const fetchTarget = `fetch("http://${process.env.REEVAL_EGRESS_TARGET}/").then((r) => r.text()).then(console.log)`

export default defineConfig({
  // As the agent: Node's fetch, stderr included. REEVAL_FIXTURE_LOUD drops NODE_OPTIONS first.
  harness: fakeHarness({
    script: [
      [{ exec: `\${REEVAL_FIXTURE_LOUD:+env -u NODE_OPTIONS} node -e '${fetchTarget}' 2>&1` }],
    ],
  }),
})
