import { defineEnvironment, evaluate, expect } from 'reeval'

// The agent starts from ./project: a list of notes and nothing that pages it.
const notes = defineEnvironment('notes', ({ directory }) => ({ files: directory('./project') }))

evaluate('revises the paging after review', { environment: notes }, async (c) => {
  await c.send(
    'Add listNotes() to src/notes.js: it returns the notes ten at a time. Add tests in ' +
      'test/notes.test.js.',
  )
  const revised = await c.send(
    'Review feedback: page by cursor, not by page number. listNotes({ cursor }) takes the id ' +
      'of the last note it returned and answers { notes, nextCursor }, with nextCursor null on ' +
      'the last page. Update the tests.',
  )

  expect(revised, 'revised notes.js').toHaveEdited('src/notes.js')
  await expect(c).toHaveFile('src/notes.js', /nextCursor/)
  await expect(c.exec('node --test')).toSucceed()
  const question = 'Did the second turn do what the review asked, and keep the tests?'
  expect(await c.judge(question, { state: { turns: 'all' } })).toPass()
})
