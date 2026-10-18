import { defineEnvironment, evaluate, expect, group } from 'reeval'

const plain = defineEnvironment('plain', {})
const design = plain.extendEnvironment('design', ({ skill }) => ({
  skills: [skill.local('../skills/design')],
}))

group(
  'landing page',
  {
    compare: {
      baseline: plain,
      variants: [design],
      questions: [
        {
          question: 'Which landing page follows the design guidelines more closely?',
          artifacts: ['home'],
        },
      ],
    },
    runs: 2,
  },
  () => {
    evaluate('builds the landing page', async (c) => {
      await c.send('Build a one-page landing site for Acme Notes in index.html. No dependencies.')
      await expect(c, 'writes index.html').toHaveFile('index.html', /Acme Notes/)
      const site = await c.serve('npx -y serve@14 -l $PORT', 3000)
      await c.capture(site, { name: 'home' })
    })
  },
)
