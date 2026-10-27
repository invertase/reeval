import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// As the agent: print both secrets, and add a file of 1234 lines, so the transcript has a
// `"added": 1234` beside the `null`s every record has.
export default defineConfig({
  harness: fakeHarness({
    script: [[{ exec: 'printf "%s\\n" "$PIN" "$PLACEHOLDER"' }]],
    files: { 'pins.txt': 'pin\n'.repeat(1234) },
  }),
})
