import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

// The fake's rules land in AGENTS.md. It writes the changelog as those rules say: the typed
// entry when they spell out the format, a plain line when they only ask for one.
const changelog = `if grep -q 'feat' AGENTS.md; then
  printf '## Unreleased\\n\\n- feat: add multiply(a, b) to src/math.js\\n' > CHANGELOG.md
else
  printf '# Changelog\\n\\nAdded multiply(a, b).\\n' > CHANGELOG.md
fi`

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent's files into the workspace and follows its rules
  // file, so the arms differ without keys or Docker.
  harness: fakeHarness({
    script: [[{ exec: changelog }]],
    files: { 'src/math.js': fakeAgent('src/math.js') },
    text: 'I added multiply(a, b) to src/math.js and recorded it in CHANGELOG.md.',
  }),
  sandbox: fakeSandbox(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
