import type { FakeHarnessDescriptor } from 'reeval/harness'

type Layout = NonNullable<FakeHarnessDescriptor['layout']>

/** The harness this run mimics: features.test.ts runs the fixture once per harness. */
export const layout = process.env.REEVAL_FIXTURE_LAYOUT as Layout
if (!layout) throw new Error('set REEVAL_FIXTURE_LAYOUT to the harness the fake agent mimics')

const anywhere = (name: string) =>
  `find "$HOME/.ai-sdk-harness" -name ${name} \\( -type f -o -type l \\) -perm -u+x | head -1`
const bootstrap = (path: string) => `ls "$HOME"/.ai-sdk-harness/.harness-bootstrap/${path}`

/**
 * A command that prints the path of the harness's CLI in its image, and the CLI's name. A CLI that
 * runs with a private home has it there; `version` is what `--version` must print.
 */
const CLIS: Partial<Record<Layout, { find: string; name: string; version?: RegExp }>> = {
  antigravity: { find: anywhere('agy'), name: 'agy' },
  'claude-code': { find: anywhere('claude'), name: 'claude' },
  codex: { find: bootstrap('codex/bin/codex'), name: 'codex' },
  fx: { find: bootstrap('fx/implementation/home/.local/bin/fx'), name: 'fx' },
  goose: { find: bootstrap('goose/implementation/home/.local/bin/goose'), name: 'goose' },
  'grok-build': { find: bootstrap('grok-build/implementation/home/.local/bin/grok'), name: 'grok' },
  opencode: {
    find: bootstrap('opencode/implementation/node_modules/.bin/opencode'),
    name: 'opencode',
    version: /^opencode v2\./,
  },
  pi: { find: bootstrap('pi/node_modules/.bin/pi'), name: 'pi' },
}

const cli = CLIS[layout]
if (!cli) throw new Error(`no CLI path for ${layout}`)
export const harnessCli = cli
