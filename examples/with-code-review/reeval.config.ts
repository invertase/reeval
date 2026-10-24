import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')
const canary = (path: string) => readFileSync(new URL(`./canary/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that replies with ./fake-agent's review and edits nothing, and a judge with
  // a fixed score, so the checks run without keys or Docker.
  harness: fakeHarness({ text: fakeAgent('review.md') }),
  sandbox: fakeSandbox(),
  judge: { model: fakeJudge({ score: 0.9 }) },
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: {
    ...profiles,
    // An agent that fixes the bug instead of reporting it, which the no-edits guard must catch.
    canary: {
      defaults: {
        harness: fakeHarness({
          files: { 'src/page.js': canary('src/page.js') },
          text: 'page() was off by one; I fixed it.',
        }),
      },
    },
  },
})
