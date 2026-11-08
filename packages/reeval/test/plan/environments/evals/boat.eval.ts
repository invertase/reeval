import { defineEnvironment, evaluate } from 'reeval'
import {
  antigravity,
  claudeCode,
  codex,
  cursor,
  fx,
  goose,
  grokBuild,
  opencode,
  pi,
} from 'reeval/harness'
import { boat, createBoat } from 'reeval/sandbox/boat'

const small = defineEnvironment('small', { sandbox: boat(), egress: 'allow-all' })
const large = defineEnvironment('large', { sandbox: boat({ type: 'large' }), egress: 'allow-all' })
const team = defineEnvironment('team', {
  sandbox: createBoat({ prefix: 'team' })(),
  egress: 'allow-all',
})

const pooled = defineEnvironment('pooled', {
  sandbox: boat({ reuse: true, attemptsPerMachine: 3 }),
  egress: 'allow-all',
})

evaluate('boat', { environments: small }, async () => {})
evaluate('boat pooled', { environments: pooled }, async () => {})
evaluate('boat large', { environments: large }, async () => {})
evaluate('boat on a team prefix', { environments: team }, async () => {})
evaluate(
  'boat on every real harness',
  {
    environments: small,
    harnesses: [
      cursor({ model: 'composer-2.5' }),
      claudeCode({ model: 'claude-sonnet-5' }),
      antigravity({ model: 'gemini-3.8-flash-medium' }),
      opencode({ model: 'google/gemini-3.8-flash' }),
      goose({ model: 'google/gemini-3.8-flash' }),
      pi({ model: 'google/gemini-3.8-flash' }),
      codex({ model: 'gpt-5.6-luna' }),
      fx({ model: 'gpt-4.1-mini' }),
      grokBuild({ model: 'grok-4.6' }),
    ],
  },
  async () => {},
)

const inImage = defineEnvironment('in-image', {
  sandbox: boat({ from: 'python:3.12-slim', install: ['pip install pytest'] }),
  egress: 'deny-all',
})
const sharedImage = defineEnvironment('shared-image', {
  sandbox: boat({ image: 'ghcr.io/acme/agent:1', attemptsPerMachine: 2, reuse: true }),
  egress: { setup: 'allow-all', agent: { allow: ['example.com'] } },
})

evaluate('boat in an image under deny-all', { environments: inImage }, async () => {})
evaluate(
  'boat image slots share a machine on claude-code',
  { environments: sharedImage, harnesses: claudeCode({ model: 'claude-sonnet-5' }) },
  async () => {},
)
