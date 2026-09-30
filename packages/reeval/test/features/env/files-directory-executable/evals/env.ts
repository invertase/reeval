import { defineEnvironment } from 'reeval'

// features.test.ts makes fixture/bin/run.sh executable (and notes.txt not) before the run.
export const executables = defineEnvironment('executables', ({ directory }) => ({
  files: directory('../fixture'),
}))

export const modes =
  'for f in bin/run.sh notes.txt; do test -x $f && echo "$f x" || echo "$f -"; done'
