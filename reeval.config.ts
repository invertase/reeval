// Dogfood: one customer-shaped reeval project at the repo root (see evals/README.md).
// Real agents only — no fake harness on these evals. Cheap gates live in packages/reeval/test/features/.
import { defineConfig } from 'reeval'
import { cursor } from 'reeval/harness'

export default defineConfig({
  include: ['evals/*.eval.ts'],
  harness: cursor({ model: 'composer-2.5' }),
  judge: { model: 'google/gemini-3.8-flash', threshold: 0.8 },
  timeout: '15m',
  profiles: {
    // One run per cell, no compare variants — sized for a quick local or PR spot-check.
    pr: {
      limit: { runs: 1, compare: false },
      budget: { attempts: 12, duration: '45m' },
    },
    // A single cheap eval for smoke checks (tag evals you want in this profile).
    smoke: {
      limit: { runs: 1, compare: false },
      tags: ['smoke'],
      budget: { attempts: 4, duration: '20m' },
    },
    // Recorded runs for history, studio and compare (real agents, commit evals/.history).
    nightly: {
      defaults: { runs: 2 },
      record: 'always',
      budget: { attempts: 80, duration: '3h' },
    },
  },
})
