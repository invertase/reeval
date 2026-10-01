import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

export const plain = defineEnvironment('plain', { sandbox })

// httpbin echoes the load balancer's trace id, which stamps the time it served the request in
// hex: only a real fetch gets one, and it can't be one from the model's training data.
export const prompt =
  'Use your built-in web fetch tool (not the shell, not curl) to fetch https://httpbin.org/headers. ' +
  'Reply with the exact value of its X-Amzn-Trace-Id header and nothing else.'

export const traceId = /Root=1-([0-9a-f]{8})-[0-9a-f]{24}/
