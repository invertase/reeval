import { defineEnvironment, evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'

const sandbox = fakeSandbox()
const none = defineEnvironment('no-skill', { sandbox })
const skilled = defineEnvironment('new-skill', ({ skill }) => ({
  sandbox,
  skills: [skill.local('../skills/s')],
}))
const newSkill = [0.98, 0.09, 0.97]
const model = fakeJudge({
  score: (s) => (s.output === 'skilled' ? (newSkill.shift() ?? 0.98) : 0.96),
})
evaluate('sign-in', { compare: { baseline: none, variants: [skilled] }, runs: 3 }, async (c) => {
  await c.send('Build sign-in')
  expect
    .soft(await c.judge('Does the app offer email sign-in?', { model }), 'Email sign-in')
    .toPass()
})
