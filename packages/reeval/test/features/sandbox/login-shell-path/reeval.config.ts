import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker only: login shells read the image's /etc/profile. The `from` image is built locally
// from ./image by the fixture's `prepare`, and puts /opt/reeval-fixture/bin on PATH. As the
// agent, a login shell looks the tool up: `sh -lc` as Cursor runs one, `bash -lc` as others do.
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
