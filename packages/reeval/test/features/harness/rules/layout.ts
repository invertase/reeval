import type { FakeHarnessDescriptor } from 'reeval/harness'

/** The harness this run mimics: features.test.ts runs the fixture once per harness. */
export const layout = process.env.REEVAL_FIXTURE_LAYOUT as NonNullable<
  FakeHarnessDescriptor['layout']
>
if (!layout) throw new Error('set REEVAL_FIXTURE_LAYOUT to the harness the fake agent mimics')

/**
 * The workspace file the harness reads `rules` from, and the other agents' file, where nothing
 * is written. Claude Code reads CLAUDE.md; every other harness reads AGENTS.md.
 */
export const [rulesFile, otherFile] =
  layout === 'claude-code' ? ['CLAUDE.md', 'AGENTS.md'] : ['AGENTS.md', 'CLAUDE.md']
