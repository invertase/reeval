import type { FakeHarnessDescriptor } from 'reeval/harness'

type Layout = NonNullable<FakeHarnessDescriptor['layout']>

/** The harness this run mimics: features.test.ts runs the fixture once per harness. */
export const layout = process.env.REEVAL_FIXTURE_LAYOUT as Layout
if (!layout) throw new Error('set REEVAL_FIXTURE_LAYOUT to the harness the fake agent mimics')

/**
 * The harness's own home skill directory, where a plugin kept whole must not be placed: Codex
 * installs the plugin from its home marketplace, Grok Build loads it with --plugin-dir.
 */
const OWN_SKILLS: Partial<Record<Layout, string>> = {
  codex: '~/.agents/skills',
  'grok-build': '~/.ai-sdk-harness/.harness-bootstrap/grok-build/implementation/home/.grok/skills',
}

const own = OWN_SKILLS[layout]
if (!own) throw new Error(`${layout} doesn't keep plugins whole`)
export const ownSkills = own
