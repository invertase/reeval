import { evaluate, expect, HarnessCapabilityError } from 'evalsuite'
import { plain, prompt, traceId } from './env.ts'

// The agent really fetched the page, and the transcript shows it: or, while the Cursor SDK
// drops web tool calls, the turn says web fetches are unreported and toHaveFetched() refuses.
evaluate('lands', { environment: plain }, async (t) => {
  const turn = await t.send(prompt)
  expect(turn.status).toBe('completed')
  const id = traceId.exec(turn.text)
  expect(id, turn.text).not.toBeNull()
  const servedAt = Number.parseInt(id?.[1] ?? '0', 16) * 1000
  expect(Math.abs(servedAt - Date.parse(turn.startedAt))).toBeLessThan(10 * 60_000)
  const shell = turn.transcript.filter(
    (e) => e.type === 'tool' && JSON.stringify(e.input).includes('httpbin'),
  )
  expect(shell, 'fetched with the web tool, not the shell').toEqual([])
  if (turn.unreported.includes('web-fetch')) {
    expect(() => expect(turn).toHaveFetched('httpbin.org')).toThrow(HarnessCapabilityError)
  } else {
    expect(turn).toHaveFetched('https://httpbin.org/headers')
  }
})
