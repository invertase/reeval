import { evaluate, expect } from 'reeval'
import { baseline, variant } from './env.ts'

// The question's calls are saved with the prompt (its token masked) and the landing capture's ref.
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
    await c.send(`write the page for ${process.env.REEVAL_FIXTURE_TOKEN}`)
    const server = await c.serve('node server.mjs')
    await c.capture(server, { name: 'aside' })
    const landing = await c.capture(server, { name: 'landing' })
    expect(landing.file.path).toBe('artifacts/landing.png')
  },
)
