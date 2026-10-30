import { defineEnvironment, evaluate, expect } from 'reeval'

const env = defineEnvironment('puzzle', ({ directory }) => ({ files: directory('./project') }))

evaluate('edits and reasons', { environment: env }, async (c) => {
  await c.send(
    'Think carefully about the algorithm first. Then implement maxMeetings in src/schedule.js ' +
      '(the most meetings, as [start, end) pairs, attendable without overlap; a meeting may start when the last ends). ' +
      'Also create src/NOTES.md with one sentence explaining why the greedy choice is correct. ' +
      'Use your file-editing tools for both files, then run `node --test` once.',
  )
  await expect(c).toHaveFile('src/NOTES.md', /\S/)
  await expect(c.exec('node --test')).toSucceed()
})
