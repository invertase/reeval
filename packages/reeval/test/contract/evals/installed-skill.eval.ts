import { evaluate, expect } from 'reeval'
import { INSTALLED_PROOF, installed, prompts, trimmed, withFakeInstalled } from './probes.ts'

// A skill a setup step installed, not the environment's `skills`, is the agent's to use: the
// proof it writes is only in the skill. The record check (host side) counts the use in skill_reads.
evaluate(
  'installed skill',
  { environments: installed, harnesses: withFakeInstalled },
  async (c) => {
    await c.send(prompts.installed)
    expect(await trimmed(c.readFile, 'installed-proof.txt')).toBe(INSTALLED_PROOF)
  },
)

// Must fail: with no turn, nothing has written the proof.
evaluate('installed skill canary', { environments: installed }, async (c) => {
  expect(await trimmed(c.readFile, 'installed-proof.txt')).toBe(INSTALLED_PROOF)
})
