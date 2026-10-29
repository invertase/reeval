import { defineEnvironment, type Turn } from 'reeval'
import { docker, fakeSandbox } from 'reeval/sandbox'

const sandbox =
  process.env.REEVAL_FIXTURE_SANDBOX === 'docker'
    ? docker()
    : fakeSandbox({ dir: new URL('../sandboxes', import.meta.url) })

// deny-all: the search goes to generativelanguage.googleapis.com, the harness's automatic host.
export const closed = defineEnvironment('closed', { sandbox, egress: 'deny-all' })

export const prompt =
  'Use your web search tool (not the shell, not curl) once, to search for "google antigravity ' +
  'cli". Then reply with one URL it found and nothing else.'

/** Whether each of the turn's web searches succeeded. */
export const searched = (turn: Turn) =>
  turn.transcript.flatMap((e) => (e.type === 'web-search' ? [e.ok !== false] : []))
