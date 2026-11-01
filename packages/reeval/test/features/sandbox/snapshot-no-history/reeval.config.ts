import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// As the agent: every object of every snapshot git dir it can reach, searched for what the seeded
// file held before c.writeFile replaced it (HEALTHY-ORIGINAL) and for the edit turn 1 made to that
// same file (TURN1-SEEDED-EDIT), which the between-turns placement should prune with it. The fake
// sandbox's state sits beside its HOME.
const probe = [
  'found=',
  'for d in "$PWD"/../.reeval-git-* "$HOME.state/workspace.git" /var/lib/reeval/workspace.git; do',
  '  [ -d "$d" ] || continue',
  '  git --git-dir="$d" cat-file --batch-all-objects --batch 2>/dev/null | grep -qE \'HEALTHY-ORIGINAL|TURN1-SEEDED-EDIT\' && found="$found $d"',
  'done',
  'echo "pre-seed content in:${found:- nowhere}"',
].join('\n')

// Turn 1 edits the seeded file (so its diff capture writes a TURN1-SEEDED-EDIT object) and a second
// file (so a turn-1 edit survives in the final diff); turn 2 runs the probe. The eval places a
// hidden version over the seeded file between the two turns.
// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
export default defineConfig({
  harnesses: fakeHarness({
    script: [
      [{ exec: "printf 'turn1\\n' >> notes.txt && printf 'TURN1-SEEDED-EDIT\\n' > src/sum.js" }],
      [{ exec: probe }],
    ],
  }),
})
