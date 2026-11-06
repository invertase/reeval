import { readFileSync } from 'node:fs'
import { evaluate, expect } from 'reeval'
import { task } from '../lib/task.ts'

const answer = readFileSync(new URL('../data/answer.txt', import.meta.url), 'utf8').trim()

evaluate('answer', async (c) => {
  const turn = await c.send(task)
  expect(turn.text).toBe('hi')
  expect(answer).toBe('42')
})

// Set only where a test asks for a plan that differs from the bundle's.
if (process.env.BUNDLE_SECOND_EVAL) evaluate('second', async () => {})
