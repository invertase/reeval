import type { FakeHarnessDescriptor } from 'reeval/harness'

/** The harness this run mimics: features.test.ts runs the fixture once per harness tart() runs. */
export const layout = process.env.REEVAL_FIXTURE_LAYOUT as NonNullable<
  FakeHarnessDescriptor['layout']
>
if (!layout) throw new Error('set REEVAL_FIXTURE_LAYOUT to the harness the fake agent mimics')

/** The variable the harness's key is in, which the gateway brokers. */
export const credential = process.env.REEVAL_FIXTURE_CREDENTIAL ?? ''
if (!credential) throw new Error(`set REEVAL_FIXTURE_CREDENTIAL to ${layout}'s key variable`)
