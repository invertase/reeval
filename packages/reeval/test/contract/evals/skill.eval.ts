import { evaluate, expect } from 'reeval'
import { prompts, SKILL_PROOF, skilled, trimmed } from './probes.ts'

// The skill is placed where this harness's agent reads it, and the agent uses it: the proof it
// writes is only in the skill. The record's context (host side) shows where it was placed.
evaluate('skill', { environment: skilled }, async (c) => {
  await c.send(prompts.skill)
  expect(await trimmed(c.readFile, 'skill-proof.txt')).toBe(SKILL_PROOF)
})

// Must fail: with no turn, nothing has written the proof.
evaluate('skill canary', { environment: skilled }, async (c) => {
  await c.sandbox()
  expect(await trimmed(c.readFile, 'skill-proof.txt')).toBe(SKILL_PROOF)
})
