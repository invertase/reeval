import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
// A heredoc write, as Claude Code makes with Bash: no file-edit event, only the workspace diff.
export default defineConfig({
  harness: fakeHarness({ script: [[{ exec: "cat <<'EOF' > notes.txt\nhello\nEOF" }]] }),
})
