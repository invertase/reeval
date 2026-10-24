import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis } from 'reeval/judge'
import { docker, fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent's files into the workspace: both arms add the
  // button, and only the one with the skill styles it. The fake sandbox saves a 1×1 placeholder
  // for each screenshot.
  harness: fakeHarness({
    files: { 'index.html': fakeAgent('without-skill/index.html') },
    text: 'I added a Sign up button under the intro paragraph.',
    withSkill: {
      files: { 'index.html': fakeAgent('with-skill/index.html') },
      text: 'I added a Sign up button in the brand blue under the intro paragraph.',
    },
  }),
  sandbox: fakeSandbox(),
  // The model that answers the questions. This fake votes for the side whose diff has the
  // brand blue, without looking at the screenshots; set one that takes images, such as
  // 'anthropic/claude-sonnet-5', for real votes. It writes no insights, so they're off.
  analysis: {
    model: fakeAnalysis({ vote: (pair) => (pair.a.diff?.includes('#2563eb') ? 'A' : 'B') }),
    insights: false,
  },
  profiles: {
    // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
    // profiles go beside them.
    ...profiles,
    // The fake agent in Docker, where Chrome takes the real screenshots; no keys.
    docker: { defaults: { sandbox: docker() } },
  },
})
