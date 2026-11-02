import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { notes } from './evals/env.ts'

// As the agent: write one file from the shell, never with an edit tool.
export default defineConfig({
  harnesses: fakeHarness({ script: [[{ exec: "printf 'from the shell\\n' > note.txt" }]] }),
  environments: notes,
})
