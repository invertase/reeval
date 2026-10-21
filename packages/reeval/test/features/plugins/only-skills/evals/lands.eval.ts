import { evaluate, expect } from 'reeval'
import { review, skill } from './env.ts'

// only: ['skills'] places the plugin's skill where the agent reads its home skills.
evaluate('lands', { environment: review }, async (c) => {
  await c.send('Lint the change.')
  expect((await c.exec(`cat ${skill}`)).stdout).toContain('Run `npm run lint`')
})
