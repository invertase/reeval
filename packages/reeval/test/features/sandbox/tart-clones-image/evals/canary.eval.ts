import { evaluate, expect } from 'reeval'
import { mac } from './env.ts'

// Must fail: the clone's image is the pinned one, not latest.
evaluate('canary', { environments: mac }, async (c) => {
  const r = await c.exec('cat ../../image')
  expect(r.stdout.trim()).toBe('ghcr.io/cirruslabs/macos-sequoia-base:latest')
})
