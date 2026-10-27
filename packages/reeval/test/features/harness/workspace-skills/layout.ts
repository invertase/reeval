import type { FakeHarnessDescriptor } from 'reeval/harness'

type Layout = NonNullable<FakeHarnessDescriptor['layout']>

/** The harness this run mimics: features.test.ts runs the fixture once per harness. */
export const layout = process.env.REEVAL_FIXTURE_LAYOUT as Layout
if (!layout) throw new Error('set REEVAL_FIXTURE_LAYOUT to the harness the fake agent mimics')

/**
 * The repo skill directory each harness reads, where a workspace-placed skill lands, and a
 * directory it must not land in: another agent's, or one the harness also reads but reeval
 * doesn't use.
 */
const DIRS: Record<Layout, { lands: string; not: string }> = {
  antigravity: { lands: '.agents/skills', not: '.gemini/skills' },
  'claude-code': { lands: '.claude/skills', not: '.cursor/skills' },
  codex: { lands: '.agents/skills', not: '.claude/skills' },
  cursor: { lands: '.cursor/skills', not: '.claude/skills' },
  fx: { lands: '.fx/skills', not: '.agents/skills' },
  goose: { lands: '.goose/skills', not: '.agents/skills' },
  'grok-build': { lands: '.grok/skills', not: '.agents/skills' },
  // OpenCode 2 reads .agents/skills too, but reeval places its skills in its own directory.
  opencode: { lands: '.opencode/skills', not: '.agents/skills' },
  pi: { lands: '.pi/skills', not: '.agents/skills' },
}

export const skillDirs = DIRS[layout]
