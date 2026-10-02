import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('canary', { environment: plain, capture: { port: 9 } }, async (c) => {
  await c.sandbox()
  try {
    await c.capture({ name: 'x', path: '/' })
  } catch (error) {
    expect((error as Error).message).toMatch(/skipped/)
  }
})
