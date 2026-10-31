import { evaluate, expect } from 'reeval'
import { beacon, plain, prompt, publishedAt, randomness, url } from './env.ts'

// The agent really fetched the page, and the transcript shows the fetch. The Cursor SDK drops
// web calls from its stream; the adapter's runner recovers them from the stored conversation.
evaluate('lands', { environments: plain }, async (c) => {
  const turn = await c.send(prompt)
  expect(turn.status).toBe('completed')
  const reply = beacon.exec(turn.text)
  expect(reply, turn.text).not.toBeNull()
  const round = Number(reply?.[1])
  expect(Math.abs(publishedAt(round) - Date.parse(turn.startedAt))).toBeLessThan(10 * 60_000)
  expect(reply?.[2], `round ${round}'s randomness`).toBe(await randomness(round))
  const shell = turn.transcript.filter(
    (e) => e.type === 'tool' && JSON.stringify(e.input).includes('drand'),
  )
  expect(shell, 'fetched with the web tool, not the shell').toEqual([])
  expect(turn.unreported).toEqual([])
  expect(turn).toHaveFetched(url)
})
