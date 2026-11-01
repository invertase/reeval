import { evaluate, group } from 'reeval'
import { base, skilled, terse } from './envs.ts'

// compare.control is the control cell; an inherited environments is replaced by it.
evaluate('names its control', { compare: { control: base, variants: [skilled] } }, async () => {})
group('inherits', { environments: base }, () => {
  evaluate(
    'the control replaces the group environment',
    { compare: { control: terse, variants: [skilled] } },
    async () => {},
  )
})
