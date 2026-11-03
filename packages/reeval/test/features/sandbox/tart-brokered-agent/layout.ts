import type { FakeHarnessDescriptor } from 'reeval/harness'

/** The harness this run mimics: features.test.ts runs the fixture once per harness tart() runs. */
export const layout = process.env.REEVAL_FIXTURE_LAYOUT as NonNullable<
  FakeHarnessDescriptor['layout']
>
if (!layout) throw new Error('set REEVAL_FIXTURE_LAYOUT to the harness the fake agent mimics')

/** The variable the harness's key is in, which the gateway brokers. */
export const credential = {
  cursor: 'CURSOR_API_KEY',
  'claude-code': 'ANTHROPIC_API_KEY',
  opencode: 'GOOGLE_GENERATIVE_AI_API_KEY',
  pi: 'GOOGLE_GENERATIVE_AI_API_KEY',
  codex: 'OPENAI_API_KEY',
}[layout as string]
if (!credential) throw new Error(`tart() doesn't run ${layout}`)
