import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const plain = defineEnvironment('plain', { sandbox })

/** One shell call, so the turn is at least two model calls: the call, and the reply after it. */
export const prompt = 'Run `echo ok` once with your shell tool, then reply with what it printed.'
