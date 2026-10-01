import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker({ from: 'python:3.12-slim', id: 'python' })
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url), id: 'python' })

/** The attempt's sandbox is the one this environment names. */
export const python = defineEnvironment('python', { sandbox })
