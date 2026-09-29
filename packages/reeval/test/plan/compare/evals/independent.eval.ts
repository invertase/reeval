import { defineEnvironment, evaluate } from 'reeval'
import { base } from './envs.ts'

const peer = defineEnvironment('peer', { env: { MODE: 'peer' } })
const extra = defineEnvironment('extra', { env: { MODE: 'extra' } })

// The eval's environment is not the control and is not layered under the variant.
evaluate(
  'baseline, not the eval environment',
  { environment: extra, compare: { baseline: base, variants: [peer] } },
  async () => {},
)
