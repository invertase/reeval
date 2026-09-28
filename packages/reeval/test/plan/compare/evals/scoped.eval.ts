import { evaluate } from 'reeval'
import { skilled } from './envs.ts'

evaluate('variant on b only', { compare: { variants: [skilled], harness: ['b'] } }, async () => {})
