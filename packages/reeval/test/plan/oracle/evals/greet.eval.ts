import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'

const node = defineEnvironment('node', {
  sandbox: docker({ install: ['npm i -g typescript@5'] }),
})

evaluate('fixes greet', { environment: node }, async () => {})
evaluate('on the default machine', async () => {})
