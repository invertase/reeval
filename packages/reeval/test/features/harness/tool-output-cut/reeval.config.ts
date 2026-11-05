import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
// The command prints 318,911 bytes, past the 128 KiB the transcript keeps of one output.
export default defineConfig({
  harnesses: fakeHarness({
    script: [[{ exec: "seq 1 30000 | sed 's/^/line-/'; echo END-OF-OUTPUT-77" }]],
  }),
})
