import { readFileSync } from 'node:fs'
import { defineEnvironment, evaluate, expect } from 'reeval'

// The agent starts from the small package in ./project.
const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))

// Placed after the turn, so the agent never sees it: its own tests can't stand in for it.
const clampCheck = readFileSync(new URL('./hidden/clamp.mjs', import.meta.url), 'utf8')

evaluate('adds a clamp function', { environments: math }, async (c) => {
  await c.send('Add a clamp(n, min, max) function to src/math.js, with a test.')

  await expect(c.exec('node --test'), 'its tests pass').toSucceed()
  await c.writeFile('clamp.check.mjs', clampCheck)
  await expect(c.exec('node clamp.check.mjs'), 'clamp clamps').toSucceed()
})
