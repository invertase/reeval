import { defineEnvironment } from 'evalsuite'

// deny-all: the provider's API is one of the automatic hosts, so the turn still runs.
export const closed = defineEnvironment('closed', { egress: 'deny-all' })

export const prompt =
  'Run `printenv ANTHROPIC_API_KEY GOOGLE_GENERATIVE_AI_API_KEY OPENAI_API_KEY > keys.txt; ' +
  'true` once with your shell tool, then reply "done".'

/** The keys the agent's shell saw, one per line: printenv prints only the set ones. */
export const keysSeen = (text: string | null) => (text ?? '').split('\n').filter(Boolean)
