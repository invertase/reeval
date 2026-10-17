import { defineEnvironment, evaluate } from 'reeval'

const skilled = defineEnvironment('skilled', { env: { MODE: 'x' } })

evaluate('inherits', {}, async () => {})
evaluate('compared', { compare: { variants: [skilled] } }, async () => {})
evaluate('slow', { tags: ['nightly-only'] }, async () => {})
