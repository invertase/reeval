import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('canary', { environment: plain }, async (c) => {
  await c.sandbox()
  try {
    await c.capture({ name: 'x', path: '/', port: 9 })
  } catch (error) {
    expect((error as Error).message).toMatch(/skipped/)
  }
})
