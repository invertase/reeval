import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that starts the MCP server and calls its tool, as an agent would, then copies
  // ./fake-agent's files into the workspace, so the checks run without keys or Docker.
  harnesses: fakeHarness({
    script: [[{ mcp: 'releases/latest_version' }]],
    files: { 'package.json': fakeAgent('package.json') },
    text: 'The latest release is 2.4.0, so package.json is now at 2.4.0.',
  }),
  sandbox: fakeSandbox(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
