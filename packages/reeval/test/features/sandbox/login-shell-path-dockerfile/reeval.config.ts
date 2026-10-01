import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker only: login shells read the image's /etc/profile. The Dockerfile layers on reeval's own
// image and puts /opt/reeval-fixture/bin on PATH. As the agent, a login shell looks the tool up:
// `sh -lc` as Cursor runs one, `bash -lc` as others do.
export default defineConfig({
  harness: fakeHarness({
    script: [
      [
        {
          exec: "sh -lc 'command -v reeval-fixture-tool'; bash -lc 'command -v reeval-fixture-tool'",
        },
      ],
    ],
  }),
})
