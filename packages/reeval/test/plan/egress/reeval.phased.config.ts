import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

export default defineConfig({
  harnesses: fakeHarness(),
  egress: { setup: 'allow-all', agent: { allow: ['config.example.com'] } },
  profiles: { 'agent-locked': { defaults: { egress: { agent: 'deny-all' } } } },
})
