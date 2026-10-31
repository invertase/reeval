import { defineEnvironment, evaluate, group } from 'reeval'
import { docker } from 'reeval/sandbox'

// The calls tree.eval.ts's declaration tree stands for: the two plan alike.
const built = defineEnvironment('built', {
  sandbox: docker({ dockerfile: '../docker/Dockerfile' }),
})
const own = defineEnvironment('own', { sandbox: docker({ dockerfile: './images/Dockerfile' }) })

group('images', { sandbox: docker({ dockerfile: './images/Dockerfile' }) }, () => {
  evaluate('from the group', async () => {})
})
evaluate('an environment', { environments: built }, async () => {})
evaluate('a compare', { compare: { baseline: built, variants: [own] } }, async () => {})
