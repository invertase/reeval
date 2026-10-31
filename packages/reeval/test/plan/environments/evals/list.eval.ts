import { defineEnvironment, evaluate, group } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

const next = defineEnvironment('nextjs', { sandbox: docker({ from: 'node:24-bookworm' }) })
const python = defineEnvironment('python', { env: { STACK: 'python' } })
const plain = defineEnvironment('plain', {})

// Each environment is its own cell beside each harness: 2 × 2.
evaluate(
  'a grid',
  {
    environments: [next, python],
    harnesses: [fakeHarness({ id: 'one' }), fakeHarness({ id: 'two' })],
  },
  async () => {},
)

// The edits work on the inherited list, here the config's node22.
evaluate('add, as data', { environments: { add: next } }, async () => {})
evaluate('add, as a function', { environments: (e) => [...e, next] }, async () => {})

group('both stacks', { environments: [next, python] }, () => {
  evaluate('inherits the list', async () => {})
  evaluate('only, as data', { environments: { only: 'python' } }, async () => {})
  evaluate('only, as a function', { environments: (e) => e.slice(0, 1) }, async () => {})
  // A compare names its own control, so the group's list isn't applied.
  evaluate(
    'a compare replaces it',
    { compare: { control: plain, variants: [next] } },
    async () => {},
  )
})
