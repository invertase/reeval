import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { fakeAnalysis } from 'evalsuite/judge'
import { fakeSandbox } from 'evalsuite/sandbox'

// A record corpus entry (Cursor, Claude Code, Antigravity, OpenCode, Goose, pi and Codex in Docker, one tiny eval each), recorded by ES 0.0.1 at 17bdeb6.
// Don't re-record it: test/corpus.test.ts reads it to prove this shape still loads.
export default defineConfig({
  harness: fakeHarness(),
  sandbox: fakeSandbox(),
  analysis: {
    model: fakeAnalysis({
      output: () => ({
        tldr: 'corpus',
        whatHappened: [],
        results: [],
        why: [],
        anomalies: [],
        actions: [],
        confidence: { overall: 'low', why: 'corpus' },
      }),
    }),
  },
})
