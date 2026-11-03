import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// tart() on the fake `tart`. As the agent, through the VM's harness session: Cursor's key, which
// the gateway brokers, and the proxy it goes out through.
export default defineConfig({
  harnesses: fakeHarness({
    layout: 'cursor',
    brokers: true,
    script: [[{ exec: 'printf "%s\\n" "$CURSOR_API_KEY"; printenv HTTPS_PROXY || echo no-proxy' }]],
  }),
})
