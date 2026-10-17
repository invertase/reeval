import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('canary', { environment: plain }, async (c) => {
  try {
    await c.capture(9, { name: 'x' })
  } catch (error) {
    expect((error as Error).message).toMatch(/skipped/)
  }
})
