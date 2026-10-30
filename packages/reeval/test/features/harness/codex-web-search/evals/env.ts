import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

// deny-all: the search goes to api.openai.com, the harness's automatic host.
export const closed = defineEnvironment('closed', { sandbox, egress: 'deny-all' })

export const prompt =
  'Use your web search tool (not the shell, not curl) once, to search for "openai codex cli ' +
  'github". Then reply with the URL of the repository it finds and nothing else.'
