import { evaluate, expect } from 'reeval'
import { mac } from './env.ts'

// The VM is a clone of the image Tart already had: the run pulled nothing.
evaluate('lands', { environments: mac }, async (c) => {
  const r = await c.exec('cat ../../image')
  expect(r.stdout.trim()).toBe('ghcr.io/cirruslabs/macos-sequoia-base:15.6')
})
