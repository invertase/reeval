import { evaluate } from 'reeval'
import { composed, everything, picked, whole } from './env.ts'

evaluate('a whole directory', { environment: whole }, async () => {})
evaluate('globs and into', { environment: picked }, async () => {})
evaluate('without the default ignores', { environment: everything }, async () => {})
evaluate(
  'a variant adds a directory',
  { compare: { baseline: whole, variants: [composed] } },
  async () => {},
)
