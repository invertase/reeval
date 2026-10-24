import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'
import { docker, fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent's files into the workspace, so the eval runs
  // without keys or Docker. The fake sandbox drives no journey and saves a 1×1 placeholder.
  harness: fakeHarness({
    files: { 'index.html': fakeAgent('index.html') },
    text: 'The Show price button now reveals the price.',
  }),
  sandbox: fakeSandbox(),
  judge: { model: fakeJudge({ score: 0.9 }) },
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: {
    ...profiles,
    // The fake agent in Docker, where Chrome takes the shot and Claude clicks the button and
    // judges it; ANTHROPIC_API_KEY.
    docker: { defaults: { sandbox: docker() }, judge: { model: 'anthropic/claude-sonnet-5' } },
  },
})
