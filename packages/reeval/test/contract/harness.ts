import {
  antigravity,
  claudeCode,
  codex,
  cursor,
  fakeHarness,
  fx,
  goose,
  grokBuild,
  opencode,
  pi,
} from 'reeval/harness'
import { fakeScript } from './evals/probes.ts'

// The harness contract.test.ts picks for the run (REEVAL_CONTRACT_HARNESS, REEVAL_CONTRACT_MODEL);
// without one it's the scripted fake agent with Cursor's layout, the key-free row that checks the
// suite itself.
const model = process.env.REEVAL_CONTRACT_MODEL ?? ''

/** The row's harness, with `effort` when it's given: the effort eval's cell. */
export const contractHarness = (effort?: string) => {
  const e = effort ? { effort } : {}
  switch (process.env.REEVAL_CONTRACT_HARNESS) {
    case 'cursor':
      // fast=false: the standard-priced variant, pinned though it is the default.
      return cursor({ model, params: { fast: 'false' }, ...e })
    case 'antigravity':
      return antigravity({ model, ...e })
    case 'claude-code':
      return claudeCode({ model, ...e })
    case 'opencode':
      return opencode({ model, ...e })
    case 'goose':
      return goose({ model, ...e })
    case 'pi':
      return pi({ model, ...e })
    case 'codex':
      return codex({ model, ...e })
    case 'grok-build':
      return grokBuild({ model, ...e })
    case 'fx':
      return fx({ model })
    default:
      return fakeHarness({ layout: 'cursor', script: [fakeScript] })
  }
}
