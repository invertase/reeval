import { defineEnvironment, evaluate } from 'reeval'
import { boat, createBoat } from 'reeval/sandbox/boat'

const small = defineEnvironment('small', { sandbox: boat(), egress: 'allow-all' })
const large = defineEnvironment('large', { sandbox: boat({ type: 'large' }), egress: 'allow-all' })
const team = defineEnvironment('team', {
  sandbox: createBoat({ prefix: 'team' })(),
  egress: 'allow-all',
})

evaluate('boat', { environments: small }, async () => {})
evaluate('boat large', { environments: large }, async () => {})
evaluate('boat on a team prefix', { environments: team }, async () => {})
