// The harnesses the examples use, defined once so the config, evals and profile limits share them.
import { claudeCode, cursor } from 'evalsuite/harness'

export const composer = cursor({ model: 'composer-2.5' }) // id cursor:composer-2.5
export const claude = claudeCode({ model: 'claude-sonnet-5' }) // id claude-code:claude-sonnet-5
