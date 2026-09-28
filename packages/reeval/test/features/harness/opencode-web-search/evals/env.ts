import { defineEnvironment, type Turn } from 'reeval'

// deny-all: the search host is one the adapter's automatic hosts let through.
export const closed = defineEnvironment('closed', { egress: 'deny-all' })

export const prompt =
  'Use your websearch tool (not the shell, not curl) once, to search for "anomalyco opencode ' +
  'github". Then reply with the first result\'s URL and nothing else.'

/** What the turn's web searches found: each web-search event's references. */
export const references = (turn: Turn) =>
  turn.transcript.flatMap((e) => (e.type === 'web-search' ? [e.references ?? 0] : []))
