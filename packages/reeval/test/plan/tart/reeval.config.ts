import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { tart } from 'reeval/sandbox'

// Tart keeps the VM's own network, so its evals run under allow-all.
const mac = defineEnvironment('mac', {
  sandbox: tart({ image: 'ghcr.io/cirruslabs/macos-sequoia-base:latest' }),
})

export default defineConfig({ harnesses: fakeHarness(), environments: mac, egress: 'allow-all' })
