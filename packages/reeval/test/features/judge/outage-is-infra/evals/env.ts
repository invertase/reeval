import { defineEnvironment } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const app = defineEnvironment('app', { sandbox })

/** A judge whose provider rate-limits every call, as it would through each retry. */
export const outage = fakeJudge({
  score: () => {
    throw Object.assign(new Error('rate limit exceeded'), { statusCode: 429 })
  },
})
