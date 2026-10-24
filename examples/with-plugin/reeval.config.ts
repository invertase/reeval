import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that calls the plugin's MCP server, as an agent following the release skill
  // would, then copies ./fake-agent's files into the workspace, so the checks run without keys or
  // Docker.
  harness: fakeHarness({
    script: [[{ mcp: 'release:releases/next_version' }]],
    files: {
      'package.json': fakeAgent('package.json'),
      'CHANGELOG.md': fakeAgent('CHANGELOG.md'),
    },
    text: 'Released 1.3.0: package.json and CHANGELOG.md are updated.',
  }),
  sandbox: fakeSandbox(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
