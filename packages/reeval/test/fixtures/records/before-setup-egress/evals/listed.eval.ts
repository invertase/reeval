import { defineEnvironment, evaluate, expect } from 'reeval'
import { docker } from 'reeval/sandbox'

const listed = defineEnvironment('listed', {
  sandbox: docker(),
  egress: { allow: ['172.30.0.2'] },
  setup: [{ run: 'curl -sS -m 10 -o /dev/null http://172.30.0.2:18777/' }],
})

// The listed host is contacted in setup and by the agent; the unlisted one is refused.
evaluate('listed', { environments: listed }, async (c) => {
  const turn = await c.send('reach both hosts')
  expect(turn.transcript.some((e) => e.type === 'tool')).toBe(true)
})
