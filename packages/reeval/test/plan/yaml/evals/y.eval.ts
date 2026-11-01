import { defineEnvironment, evaluate } from 'reeval'

const plain = defineEnvironment('plain', {})
const skilled = defineEnvironment('skilled', { env: { MODE: 'x' } })

evaluate('inherits', {}, async () => {})
evaluate('compared', { compare: { control: plain, variants: [skilled] } }, async () => {})
evaluate('slow', { tags: ['nightly-only'] }, async () => {})
