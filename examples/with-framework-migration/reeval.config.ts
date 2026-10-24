import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that writes ./fake-agent's files into the workspace and then runs the
  // tests, so the checks, toHaveRun included, run without keys or Docker.
  harness: fakeHarness({
    script: [
      [
        {
          write: {
            'package.json': fakeAgent('package.json'),
            'src/temperature.js': fakeAgent('src/temperature.js'),
            'src/report.js': fakeAgent('src/report.js'),
            'test/report.test.js': fakeAgent('test/report.test.js'),
          },
        },
        { exec: 'npm test' },
        { reply: 'The package is ES modules now, and npm test passes.' },
      ],
    ],
  }),
  sandbox: fakeSandbox(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
