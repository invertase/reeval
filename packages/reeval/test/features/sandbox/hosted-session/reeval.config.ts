import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker tier only: hosted() on the fake VM API through REEVAL_VM_URL, as a hosted run's VM
// service forwards it, whose machines are sshd containers laid out like a VM. As the agent: who
// and where the shell runs, which node it finds, and its proxy.
export default defineConfig({
  harnesses: fakeHarness({
    script: [[{ exec: 'id -un; pwd; command -v node; printenv HTTPS_PROXY || echo no-proxy' }]],
  }),
})
