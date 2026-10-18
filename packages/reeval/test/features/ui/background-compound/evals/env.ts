import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const plain = defineEnvironment('plain', { sandbox })

/** Waits up to 20s for `path` to be non-empty, then prints it. */
export const readWhenWritten = (path: string) =>
  `for i in $(seq 200); do [ -s ${path} ] && break; sleep 0.1; done; cat ${path}`
