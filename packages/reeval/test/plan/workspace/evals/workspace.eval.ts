import { evaluate } from 'reeval'
import { moving, next, pinned } from './env.ts'

evaluate('a pinned subdirectory', { environment: pinned }, async () => {})
evaluate('the default branch warns', { environment: moving }, async () => {})
evaluate(
  'a variant swaps the starting code',
  { environment: pinned, compare: { variants: [next] } },
  async () => {},
)
evaluate('no workspace', async () => {})
