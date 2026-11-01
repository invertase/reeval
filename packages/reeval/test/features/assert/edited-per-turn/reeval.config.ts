import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
// Turn 1 writes notes.txt from the shell; turn 2 only reads it, though the diff still shows it.
export default defineConfig({
  harness: fakeHarness({
    script: [[{ exec: "cat <<'EOF' > notes.txt\nhello\nEOF" }], [{ exec: 'cat notes.txt' }]],
  }),
})
