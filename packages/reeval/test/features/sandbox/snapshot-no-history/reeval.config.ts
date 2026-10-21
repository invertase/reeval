import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// As the agent: every object of every snapshot git dir it can reach, searched for what the seeded
// file held before c.writeFile replaced it. The fake sandbox's state sits beside its HOME.
const probe = [
  'found=',
  'for d in "$PWD"/../.reeval-git-* "$HOME.state/workspace.git" /var/lib/reeval/workspace.git; do',
  '  [ -d "$d" ] || continue',
  '  git --git-dir="$d" cat-file --batch-all-objects --batch 2>/dev/null | grep -q HEALTHY-ORIGINAL && found="$found $d"',
  'done',
  'echo "pre-seed content in:${found:- nowhere}"',
].join('\n')

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
export default defineConfig({
  harness: fakeHarness({ script: [[{ exec: probe }]] }),
})
