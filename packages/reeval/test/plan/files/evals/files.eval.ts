import { evaluate } from 'reeval'
import { composed, everything, picked, whole } from './env.ts'

evaluate('a whole directory', { environments: whole }, async () => {})
evaluate('globs and into', { environments: picked }, async () => {})
evaluate('without the default ignores', { environments: everything }, async () => {})
evaluate(
  'a variant adds a directory',
  { compare: { control: whole, variants: [composed] } },
  async () => {},
)
