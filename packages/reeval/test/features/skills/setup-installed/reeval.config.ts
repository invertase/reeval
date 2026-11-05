import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
// The fake agent opens the skill the setup step installed, as an agent reading its skill directory would.
export default defineConfig({
  harnesses: fakeHarness({ script: [[{ exec: 'cat .agents/skills/house-greeting/SKILL.md' }]] }),
})
