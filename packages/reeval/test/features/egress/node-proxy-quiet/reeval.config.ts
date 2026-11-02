import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker only: the fake sandbox has no gateway. REEVAL_EGRESS_TARGET is a listener on the host that
// features.test.ts starts, at a non-loopback address, so the fetch leaves only through the proxy.
const fetchTarget = `fetch("http://${process.env.REEVAL_EGRESS_TARGET}/").then((r) => r.text()).then(console.log)`

export default defineConfig({
  // As the agent: Node's fetch, stderr included, on REEVAL_FIXTURE_NODE when the environment sets it.
  harnesses: fakeHarness({
    script: [[{ exec: `\${REEVAL_FIXTURE_NODE:-node} -e '${fetchTarget}' 2>&1` }]],
  }),
})
