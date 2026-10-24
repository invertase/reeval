import { defineEnvironment, evaluate, expect } from 'reeval'

// The agent starts from ./project, with the team's conventions seeded beside it in docs/.
const notes = defineEnvironment('notes', ({ directory, file }) => ({
  files: { ...directory('./project'), 'docs/conventions.md': file('./docs/conventions.md') },
}))

evaluate('follows the handler conventions', { environment: notes }, async (c) => {
  await c.send('Add a deleteNote(id) handler to src/notes.js, following docs/conventions.md.')

  await expect(c).toHaveFile('src/notes.js', /export function deleteNote/)
  await expect(c.exec('node --test')).toSucceed()
  const question = 'Does deleteNote, and its tests, follow every rule in docs/conventions.md?'
  const contents = ['src/notes.js', 'test/notes.test.js', 'docs/**']
  expect(await c.judge(question, { state: { contents } })).toPass()
})
