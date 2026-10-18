import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  harness: fakeHarness({
    files: { 'lib/greet.js': `export const greet = (name) => \`Hello, \${name}!\`\n` },
    text: 'Created lib/greet.js.',
  }),
  sandbox: fakeSandbox(),
})
