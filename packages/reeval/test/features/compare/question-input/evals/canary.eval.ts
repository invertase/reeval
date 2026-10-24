import { evaluate, expect } from 'reeval'
import { baseline, variant } from './env.ts'

// Must fail: the capture the question's calls refer to is landing.png, not aside.png.
evaluate(
  'canary',
  {
    compare: { baseline, variants: [variant] },
    questions: [
      { question: 'Which page looks better?', across: 'environment', artifacts: ['landing'] },
    ],
  },
  async (c) => {
    await c.send(`write the page for ${process.env.REEVAL_FIXTURE_TOKEN}`)
    const server = await c.serve('node server.mjs')
    const landing = await c.capture(server, { name: 'landing' })
    expect(landing.file.path).toBe('artifacts/aside.png')
  },
)
