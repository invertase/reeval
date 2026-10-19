import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

const count = `import { readFileSync } from 'node:fs'

const users = JSON.parse(readFileSync('data/users.json', 'utf8'))
console.log(users.length)
`

export default defineConfig({
  harness: fakeHarness({
    files: { 'count.js': count },
    text: 'Created count.js.',
  }),
  sandbox: fakeSandbox(),
})
