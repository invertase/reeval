import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')
const writeMath = (dir: string) =>
  `cat > src/math.js <<'EOF'\n${fakeAgent(`${dir}/src/math.js`)}EOF`

// The fake writes src/math.js after looking for the convention where an agent would: the doc in
// the workspace, or the skill in its skills directory.
const divide = `if test -f docs/errors.md || test -f ~/.agents/skills/errors/SKILL.md; then
${writeMath('convention')}
else
${writeMath('plain')}
fi`

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that writes ./fake-agent's files into the workspace, following the
  // convention wherever it finds it, so the compare runs without keys or Docker.
  harnesses: fakeHarness({
    script: [[{ exec: divide }]],
    text: 'I added divide(a, b) to src/math.js.',
  }),
  sandbox: fakeSandbox(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
