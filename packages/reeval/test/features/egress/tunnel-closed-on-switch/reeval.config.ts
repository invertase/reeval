import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker only: the fake sandbox can't enforce a policy, so reeval run would exit 2.
export default defineConfig({ harnesses: fakeHarness() })
