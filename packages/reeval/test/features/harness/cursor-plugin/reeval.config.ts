import { defineConfig } from 'reeval'
import { cursor, fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
// REEVAL_FIXTURE_HARNESS=cursor runs it on real Cursor (C), which needs CURSOR_API_KEY. The fake
// agent takes Cursor's layout: as the agent, run the session's hook from the workspace's
// .cursor/hooks.json, then follow the unpacked rule.
export default defineConfig({
  harness:
    process.env.REEVAL_FIXTURE_HARNESS === 'cursor'
      ? cursor({ model: process.env.REEVAL_REAL_MODEL ?? 'composer-2.5' })
      : fakeHarness({
          layout: 'cursor',
          script: [
            [
              {
                exec: `sh -c "$(node -p 'require("./.cursor/hooks.json").hooks.sessionStart[0].command')"`,
              },
              { exec: `grep -o 'SAFFRON-[0-9]*' .cursor/rules/house-codeword.mdc > codeword.txt` },
              { reply: 'done' },
            ],
          ],
        }),
})
