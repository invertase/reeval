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

evaluate('boat', { environments: small }, async () => {})
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
