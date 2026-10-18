import { evaluate, expect } from 'reeval'
import { baseline, variant } from './env.ts'

// artifacts: ['landing'] sends each side's landing capture as an image, and not aside.
evaluate(
  'lands',
  {
    compare: {
      baseline,
      variants: [variant],
      questions: [{ question: 'Which page looks better?', artifacts: ['landing'] }],
    },
  },
  async (c) => {
    await c.send('write the page')
    const server = await c.serve('node server.mjs')
    await c.capture(server, { name: 'aside' })
    const landing = await c.capture(server, { name: 'landing' })
    expect(landing.file.path).toBe('artifacts/landing.png')
  },
)
