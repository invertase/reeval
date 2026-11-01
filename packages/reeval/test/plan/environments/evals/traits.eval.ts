import { defineEnvironment, evaluate } from 'reeval'

const next = defineEnvironment('next-app', { traits: { stack: 'next', auth: ['clerk', 'none'] } })
// A child's key replaces its parent's value whole; the keys it doesn't set are inherited.
const clerk = next.extend('next-clerk', { traits: { auth: 'clerk' } })
const plain = next.extend('next-plain', { env: { MODE: 'plain' } })

// Traits aren't part of the cell key: each environment is one cell, as without them.
evaluate('traits', { environments: [next, clerk, plain] }, async () => {})
