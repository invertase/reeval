import { defineEnvironment, evaluate, expect } from 'reeval'
import { docker } from 'reeval/sandbox'

const proxied = defineEnvironment('proxied', { sandbox: docker() })

// The agent probes GCP's metadata server by name and by its link-local address.
evaluate('probes metadata', { environments: proxied }, async (c) => {
  const turn = await c.send('probe the metadata server')
  expect(turn.transcript.length).toBeGreaterThan(0)
})
