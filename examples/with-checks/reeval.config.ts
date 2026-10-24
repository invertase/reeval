import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { cursor, fakeHarness } from 'reeval/harness'
import { docker, fakeSandbox } from 'reeval/sandbox'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent's files into the workspace, so the checks run without keys or Docker.
  harness: fakeHarness({
    files: {
      'src/math.js': fakeAgent('src/math.js'),
      'test/math.test.js': fakeAgent('test/math.test.js'),
    },
    text: 'I added multiply(a, b) to src/math.js and a test for it.',
  }),
  sandbox: fakeSandbox(),
  profiles: {
    // The same eval on a real agent in Docker: needs CURSOR_API_KEY and
    // `reeval image build --profile cursor` once.
    cursor: { defaults: { harness: cursor({ model: 'composer-2.5' }), sandbox: docker() } },
  },
})
