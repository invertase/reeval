import { evaluate, expect } from 'reeval'
import { executables, modes } from './env.ts'

// A file its owner may execute on the host is executable in the sandbox; others aren't.
evaluate('lands', { environments: executables }, async (c) => {
  expect((await c.exec(modes)).stdout).toBe('bin/run.sh x\nnotes.txt -\n')
})
