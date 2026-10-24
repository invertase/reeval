import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent's page into the workspace with plain/'s guessed
  // colours, or skill/'s brand ones when it has the skill, so the compare shows a lift without
  // keys or Docker.
  harness: fakeHarness({
    files: { 'index.html': fakeAgent('index.html'), 'styles.css': fakeAgent('plain/styles.css') },
    text: 'styles.css gives the page warm colours and serif body text.',
    withSkill: {
      files: {
        'index.html': fakeAgent('index.html'),
        'styles.css': fakeAgent('skill/styles.css'),
      },
      text: "styles.css uses Anthropic's brand colours, Poppins headings and Lora body text.",
    },
  }),
  sandbox: fakeSandbox(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
