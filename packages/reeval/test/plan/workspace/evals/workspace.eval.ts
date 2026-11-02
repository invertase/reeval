import { evaluate } from 'reeval'
import { moving, next, pinned } from './env.ts'

evaluate('a pinned subdirectory', { environments: pinned }, async () => {})
evaluate('the default branch warns', { environments: moving }, async () => {})
evaluate(
  'a variant swaps the starting code',
  { compare: { control: pinned, variants: [next] } },
  async () => {},
)
evaluate('no workspace', async () => {})
