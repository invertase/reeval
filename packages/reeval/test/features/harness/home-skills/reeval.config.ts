import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { layout, skillDirs } from './layout.ts'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D). The fake
// agent takes REEVAL_FIXTURE_LAYOUT's layout (and image), so no key is needed. As the agent: read
// the skill where the adapter puts it, then from the directory it must not be in.
export default defineConfig({
  harnesses: fakeHarness({
    layout,
    script: [
      [
        { exec: `cat ${skillDirs.placed}/house-greeting/SKILL.md` },
        { exec: `cat ${skillDirs.not}/house-greeting/SKILL.md` },
        { reply: 'read' },
      ],
    ],
  }),
})
