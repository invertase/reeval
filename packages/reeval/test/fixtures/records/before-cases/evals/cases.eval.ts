import { defineEnvironment, evaluate, expect, survey } from 'reeval'
import { fakeSandbox } from 'reeval/sandbox'

const sandbox = fakeSandbox()
const next = defineEnvironment('next-app', { sandbox, files: { 'stack.txt': 'next' }, traits: { stack: 'next' } })
const vite = defineEnvironment('vite-app', { sandbox, files: { 'stack.txt': 'vite' }, traits: { stack: 'vite' } })
const plain = defineEnvironment('plain', { sandbox })
const skilled = plain.extend('with-skill', { skills: [] , files: { 'skill.txt': 'yes' } })

// One case of three fails: the cell's rate over its cases, 0.67, clears its passRate 0.6, and
// the failing case carries verdict 'family'.
evaluate('rated', { gate: { passRate: 0.6 }, cases: ['a', 'b', 'c'] }, async (c, key) => {
  await c.send(`Greet ${key}.`)
  expect(key, 'passes its case').not.toBe('c')
})

// Under gate 'all', the failing case fails the eval.
evaluate('strict', { cases: [{ id: 'x' }, { id: 'y' }], runs: 2 }, async (c, item) => {
  await c.send(`Greet ${item.id}.`)
  expect(item.id, 'passes its case').toBe('x')
})

// where: each case runs on its own stack, so astro runs nowhere and is in the family's excluded.
evaluate(
  'lands',
  {
    environments: [next, vite],
    cases: ['next', 'vite', 'astro'],
    where: ({ case: stack, environment }) => environment.traits.stack === stack,
  },
  async (c, stack) => {
    expect(await c.readFile('stack.txt'), 'runs on its own stack').toBe(stack)
  },
)

// A paired lift over the cases with a minLift it can't clear.
evaluate(
  'lifted',
  { cases: ['Ada', 'Grace', 'Linus'], compare: { control: plain, variants: [skilled], minLift: 0.5 } },
  async (c, name) => {
    await c.send(`Greet ${name}.`)
    await expect(c.exec('test -f skill.txt'), 'has the skill').toSucceed()
  },
)

// One case: a plain eval named for its case.
evaluate('alone', { cases: ['only'] }, async (c, key) => {
  await c.send(`Greet ${key}.`)
})

survey('picks', { cases: ['p1', 'p2'] }, async (c, key) => {
  await c.send(`Pick for ${key}.`)
  c.observe('pick', key === 'p1' ? 'drizzle' : 'prisma')
})
