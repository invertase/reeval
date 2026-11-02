import { evaluate, expect } from 'reeval'
import { judgeSaw, tokens } from './env.ts'

// The judge is sent [REDACTED] for a `to: 'checks'` secret in a check's output and for an
// unbrokered secret the agent printed.
evaluate('lands', { environments: tokens }, async (c) => {
  const state = await judgeSaw(c, 'lands')
  const raw = [process.env.REEVAL_FIXTURE_TOKEN, process.env.REEVAL_FIXTURE_AGENT_VALUE]
  expect({
    check: state.checks?.[0]?.stdout,
    transcript: /AGENT_TOKEN[\s\S]*\[REDACTED\]/.test(state.transcript ?? ''),
    raw: raw.filter((value) => value && JSON.stringify(state).includes(value)).length,
  }).toEqual({ check: '[REDACTED]', transcript: true, raw: 0 })
})
