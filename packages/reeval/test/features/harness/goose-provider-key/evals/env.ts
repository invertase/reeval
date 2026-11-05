import { defineEnvironment } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

// deny-all: the provider's API is one of the automatic hosts, so the turn still runs.
export const closed = defineEnvironment('closed', { sandbox, egress: 'deny-all' })

export const prompt =
  'Run `printenv ANTHROPIC_API_KEY GOOGLE_GENERATIVE_AI_API_KEY OPENAI_API_KEY > keys.txt; ' +
  'true` once with your shell tool, then reply "done".'

/** The keys the agent's shell saw, one per line: printenv prints only the set ones. */
export const keysSeen = (text: string | null) => (text ?? '').split('\n').filter(Boolean)
