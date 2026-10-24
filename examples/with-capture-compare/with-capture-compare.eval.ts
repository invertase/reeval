import { defineEnvironment, evaluate, expect } from 'reeval'

const site = defineEnvironment('site', ({ directory }) => ({ files: directory('./project') }))
const withBrand = site.extendEnvironment('brand', ({ skill }) => ({
  skills: [skill.local('./skills/brand')],
}))

evaluate(
  'adds a sign-up button',
  {
    compare: {
      baseline: site,
      variants: [withBrand],
      // Each side's own `home` capture goes beside its diff; asked of pairs that passed.
      questions: [
        {
          question: 'Which Sign up button is blue with white text and rounded corners?',
          artifacts: ['home'],
        },
      ],
    },
  },
  async (c) => {
    await c.send('Add a "Sign up" button under the intro paragraph in index.html.')

    await expect(c).toHaveFile('index.html', /Sign up/)
    // server.js serves index.html on $PORT.
    const app = await c.serve('node server.js')
    await c.capture(app, { name: 'home' })
  },
)
