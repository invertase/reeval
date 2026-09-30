import { evaluate, expect } from 'reeval'
import { plain, prompt, traceId } from './env.ts'

// The agent really fetched the page, and the transcript shows the fetch. The Cursor SDK drops
// web calls from its stream; the adapter's runner recovers them from the stored conversation.
evaluate('lands', { environment: plain }, async (c) => {
  const turn = await c.send(prompt)
  expect(turn.status).toBe('completed')
  const id = traceId.exec(turn.text)
  expect(id, turn.text).not.toBeNull()
  const servedAt = Number.parseInt(id?.[1] ?? '0', 16) * 1000
  expect(Math.abs(servedAt - Date.parse(turn.startedAt))).toBeLessThan(10 * 60_000)
  const shell = turn.transcript.filter(
    (e) => e.type === 'tool' && JSON.stringify(e.input).includes('httpbin'),
  )
  expect(shell, 'fetched with the web tool, not the shell').toEqual([])
  expect(turn.unreported).toEqual([])
  expect(turn).toHaveFetched('https://httpbin.org/headers')
})
