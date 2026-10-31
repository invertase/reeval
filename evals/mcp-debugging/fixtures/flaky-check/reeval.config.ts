import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

const build = `import { mkdirSync, writeFileSync } from 'node:fs'

// Collecting the report takes a moment.
setTimeout(() => {
  mkdirSync('dist', { recursive: true })
  writeFileSync('dist/report.txt', 'ok\\n')
}, Math.random() * 400)
`

export default defineConfig({
  harnesses: fakeHarness({
    files: { 'build.js': build },
    text: 'Created build.js.',
  }),
  sandbox: fakeSandbox(),
})
