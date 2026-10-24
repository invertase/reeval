import { defineEnvironment, evaluate, expect } from 'reeval'

const pricing = defineEnvironment('pricing', ({ directory }) => ({ files: directory('./project') }))

// The journey's model: the run's judge doesn't drive it, so it's named here, under every profile.
const journey = { model: 'anthropic/claude-sonnet-5' }

evaluate('reveals the price on click', { environment: pricing, capture: journey }, async (c) => {
  await c.send('The "Show price" button in index.html does nothing. Make it reveal the price.')

  const app = await c.serve('node server.js')
  // A vision model clicks the button, as a person would, before the screenshot. Each move sees
  // only the goal and the page, so the goal says when it's met.
  const shot = await c.capture(app, {
    name: 'after-click',
    instructions: [
      'Click "Show price" if no price shows under it yet; once one shows, you are done',
    ],
  })
  expect(await c.judge('Does the screenshot show "$12 a month"?', { artifacts: [shot] })).toPass()
})
