import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { cursor, fakeHarness } from 'reeval/harness'
import { docker, fakeSandbox } from 'reeval/sandbox'

const solution = (path: string) =>
  readFileSync(new URL(`./solution/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that writes ./solution's files, so the checks run without keys or Docker.
  harness: fakeHarness({
    files: {
      'src/math.js': solution('src/math.js'),
      'test/math.test.js': solution('test/math.test.js'),
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
