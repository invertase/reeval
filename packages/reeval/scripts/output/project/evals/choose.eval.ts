import { evaluate, expect } from 'reeval'
import { fakeHarness } from 'reeval/harness'

const advisor = fakeHarness({
  id: 'advisor',
  text: 'I would build this with Genkit. If your team already writes Python, LangChain works too.',
})

// Choose a tool: the agent is asked which framework to use, and the eval wants Genkit. Every case
// names Genkit, and the Python case also wants it to be the only framework named, which it isn't.
evaluate.each([
  { task: 'a chat app', only: false },
  { task: 'a RAG pipeline', only: false },
  { task: 'a Python agent', only: true },
])('recommends Genkit for $task', { harness: advisor, runs: 2 }, async (c, { task, only }) => {
  const turn = await c.send(`Which framework should I use to build ${task}? Pick one.`)
  expect(turn.text, 'names Genkit').toContain('Genkit')
  if (only) expect(turn.text, 'names no other framework').not.toContain('LangChain')
})
