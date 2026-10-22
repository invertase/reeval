// The harnesses the examples use, defined once so the config, evals and profile limits share them.
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

export const composer = cursor({ model: 'composer-2.5' }) // id cursor:composer-2.5
export const claude = claudeCode({ model: 'claude-sonnet-5' }) // id claude-code:claude-sonnet-5
export const agy = antigravity({ model: 'gemini-3.8-flash-medium' }) // id antigravity:gemini-3.8-flash-medium
export const oc = opencode({ model: 'google/gemini-3.8-flash' }) // id opencode:gemini-3.8-flash
export const gs = goose({ model: 'gemini-3.8-flash' }) // id goose:gemini-3.8-flash
export const pim = pi({ model: 'gemini-3.8-flash' }) // id pi:gemini-3.8-flash
export const cx = codex({ model: 'gpt-5.6-luna' }) // id codex:gpt-5.6-luna
export const grok = grokBuild({ model: 'grok-4.6' }) // id grok-build:grok-4.6
export const fxGateway = fx({ model: 'anthropic/claude-sonnet-5' }) // id fx:anthropic/claude-sonnet-5
