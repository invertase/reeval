import { defineEnvironment, evaluate, group } from 'reeval'
import { base } from './envs.ts'

const peer = defineEnvironment('peer', { env: { MODE: 'peer' } })
const extra = defineEnvironment('extra', { env: { MODE: 'extra' } })

// The group's environment is inherited, not applied. Compare names both arms.
group('parent', { environments: extra }, () => {
  evaluate(
    'baseline, not the inherited environment',
    { compare: { baseline: base, variants: [peer] } },
    async () => {},
  )
})
