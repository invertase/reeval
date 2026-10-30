import type { FakeHarnessDescriptor } from 'reeval/harness'

type Layout = NonNullable<FakeHarnessDescriptor['layout']>

/** The harness this run mimics: features.test.ts runs the fixture once per harness. */
export const layout = process.env.REEVAL_FIXTURE_LAYOUT as Layout
if (!layout) throw new Error('set REEVAL_FIXTURE_LAYOUT to the harness the fake agent mimics')

const privateHome = (harness: string) => `~/.ai-sdk-harness/.harness-bootstrap/${harness}/home`

/**
 * Where each harness's adapter puts a harness-placed skill, and a directory it must not be in:
 * where the CLI's docs say it goes, the sandbox user's own home for a CLI that runs with a private
 * one, or another directory the CLI also reads.
 */
const DIRS: Partial<Record<Layout, { placed: string; not: string }>> = {
  antigravity: { placed: '~/.gemini/config/skills', not: '~/.gemini/antigravity-cli/skills' },
  'claude-code': { placed: '~/.claude/skills', not: '.claude/skills' },
  codex: { placed: '~/.agents/skills', not: '~/.codex/skills' },
  fx: { placed: `${privateHome('fx')}/.fx/skills`, not: '~/.fx/skills' },
  goose: { placed: `${privateHome('goose')}/.config/goose/skills`, not: '~/.config/goose/skills' },
  'grok-build': { placed: `${privateHome('grok-build')}/.grok/skills`, not: '~/.grok/skills' },
  // OpenCode 2 reads ~/.agents/skills too, but reeval places its skills in its own directory.
  opencode: { placed: '~/.config/opencode/skills', not: '~/.agents/skills' },
  pi: { placed: '~/.pi/agent/skills', not: '~/.agents/skills' },
}

const dirs = DIRS[layout]
if (!dirs) throw new Error(`no home skill directories for ${layout}`)
export const skillDirs = dirs
