import { defineEnvironment, evaluate } from 'reeval'

const next = defineEnvironment('next-app', { traits: { stack: 'next', auth: ['clerk', 'none'] } })
const vite = defineEnvironment('vite-app', { traits: { stack: 'vite' } })
const skilled = next.extend('next-skilled', { env: { SKILL: '1' } })

const questions = [
  { id: 'q1', stacks: ['next', 'vite'] },
  { id: 'q2', stacks: ['next'] },
  { id: 'q3', stacks: ['vite'] },
]
const fits = ({
  case: q,
  environment,
}: {
  case: (typeof questions)[number]
  environment: { traits: { stack?: unknown } }
}) => q.stacks.includes(environment.traits.stack as string)

// q2 runs on next-app only and q3 on vite-app only, on both harnesses.
evaluate(
  'stack questions',
  { environments: [next, vite], cases: questions, where: fits },
  async () => {},
)

// Reading the harness decides each harness on its own: y runs on harness a only.
evaluate(
  'per harness',
  {
    environments: [next, vite],
    cases: ['x', 'y'],
    where: ({ case: c, harness }) => c === 'x' || harness === 'a',
  },
  async () => {},
)

// The control's answer holds for its variant: q3 runs on neither arm.
evaluate(
  'with the skill',
  { compare: { control: next, variants: [skilled] }, cases: questions, where: fits },
  async () => {},
)
