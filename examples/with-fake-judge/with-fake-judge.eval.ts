import { defineEnvironment, evaluate, expect } from 'reeval'
import { fakeJudge } from 'reeval/judge'

// The agent starts from the small package in ./project, README.md included.
const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))

// Passes only when README.md reaches the judge and mentions multiply, so a wrong `contents` (a
// mistyped path, say) fails here, before a real judge costs anything. The call sends no
// captures, so the state is one JSON object.
const readsReadme = fakeJudge({
  score: (state) => {
    const { contents } = state as { contents?: Record<string, string | null> }
    return contents?.['README.md']?.includes('multiply') ? 1 : 0
  },
})

evaluate(
  'documents the new function',
  { environments: math, judge: { model: readsReadme } },
  async (c) => {
    await c.send('Add a multiply(a, b) function to src/math.js, and document it in README.md.')

    const verdict = await c.judge('Does README.md document multiply?', { contents: ['README.md'] })
    expect(verdict).toPass()
  },
)
