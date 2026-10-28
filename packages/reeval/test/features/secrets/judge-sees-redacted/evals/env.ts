import { writeFileSync } from 'node:fs'
import { type AttemptContext, defineEnvironment } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

// REEVAL_FIXTURE_AGENT_VALUE's name isn't secret-looking: only its secret() declaration masks it.
export const tokens = defineEnvironment('tokens', ({ secret }) => ({
  sandbox,
  env: {
    CHECK_TOKEN: secret.fromEnv('REEVAL_FIXTURE_TOKEN', { to: 'checks' }),
    AGENT_TOKEN: secret.fromEnv('REEVAL_FIXTURE_AGENT_VALUE'),
  },
}))

/**
 * The state a judge is sent after the agent printed its secret and a check printed the checks'
 * one, also written to `judge-saw-<name>.json` for the host to compare with `judge-input.json`.
 */
export async function judgeSaw(c: AttemptContext, name: string) {
  await c.send('print AGENT_TOKEN')
  await c.exec('printf %s "$CHECK_TOKEN"')
  let state: { checks?: Array<{ stdout: string }>; transcript?: string } = {}
  const look = fakeJudge({
    score: (s) => {
      state = s as typeof state
      return 1
    },
  })
  await c.judge('Did the agent print its token?', {
    model: look,
    checks: true,
    transcript: 'full',
  })
  writeFileSync(new URL(`../judge-saw-${name}.json`, import.meta.url), JSON.stringify(state))
  return state
}
