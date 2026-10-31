import { defineEnvironment, evaluate } from 'reeval'

const database = defineEnvironment('database', { egress: 'allow-all' })

evaluate('the default sends everything through the gateway', async () => {})
evaluate('allow-all keeps the network for raw TCP', { environments: database }, async () => {})
evaluate('an eval can ask for allow-all itself', { egress: 'allow-all' }, async () => {})
