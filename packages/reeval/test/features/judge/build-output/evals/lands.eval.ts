import { evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { app } from './env.ts'

// The judge's diff keeps the source and puts a marker in place of the build output and the
// minified bundle.
evaluate('lands', { environment: app }, async (c) => {
  await c.send('build the app')
  let diff = ''
  const look = fakeJudge({
    score: (state) => {
      diff = String(state.diff)
      return 1
    },
  })
  await c.judge('Did the agent write the app?', { model: look })
  expect(diff.match(/^(?:\+export .*|\[reeval: .*\])$/gm)).toEqual([
    '[reeval: dropped dist/ (1 file): build output]',
    '[reeval: dropped public/vendor.js: minified, a line of 1616 characters]',
    '+export const app = () => "hello"',
  ])
})
