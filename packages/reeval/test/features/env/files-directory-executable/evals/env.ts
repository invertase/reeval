import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

// features.test.ts makes fixture/bin/run.sh executable (and notes.txt not) before the run.
export const executables = defineEnvironment('executables', ({ directory }) => ({
  sandbox,
  files: directory('../fixture'),
}))

export const modes =
  'for f in bin/run.sh notes.txt; do test -x $f && echo "$f x" || echo "$f -"; done'
