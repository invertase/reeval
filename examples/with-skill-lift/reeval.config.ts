import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { cursor, fakeHarness } from 'reeval/harness'
import { docker, fakeSandbox } from 'reeval/sandbox'

const solution = (path: string) =>
  readFileSync(new URL(`./solution/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that writes ./solution's files, and the changelog entry only when it has
  // the skill, so the compare shows a lift without keys or Docker.
  harness: fakeHarness({
    files: { 'src/math.js': solution('src/math.js') },
    text: 'I added multiply(a, b) to src/math.js.',
    withSkill: {
      files: {
        'src/math.js': solution('src/math.js'),
        'CHANGELOG.md': solution('CHANGELOG.md'),
      },
      text: 'I added multiply(a, b) to src/math.js and recorded it in CHANGELOG.md.',
    },
  }),
  sandbox: fakeSandbox(),
  profiles: {
    // The same compare on a real agent in Docker: needs CURSOR_API_KEY and
    // `reeval image build --profile cursor` once.
    cursor: { defaults: { harness: cursor({ model: 'composer-2.5' }), sandbox: docker() } },
  },
})
