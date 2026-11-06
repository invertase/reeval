import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  harnesses: fakeHarness({ script: [[{ reply: 'hi' }]] }),
  sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }),
  environments: defineEnvironment('fake', ({ skill, secret }) => ({
    skills: [skill.local('./skills/guide')],
    env: { CHECK_TOKEN: secret.fromEnv('CHECK_TOKEN') },
  })),
  judge: { model: fakeJudge({ score: 0.9 }) },
})
