// The harnesses the examples use, defined once so the config, evals and profile limits share them.
import { antigravity, claudeCode, cursor } from 'evalsuite/harness'

export const composer = cursor({ model: 'composer-2.5' }) // id cursor:composer-2.5
export const claude = claudeCode({ model: 'claude-sonnet-5' }) // id claude-code:claude-sonnet-5
export const agy = antigravity({ model: 'gemini-3.8-flash-medium' }) // id antigravity:gemini-3.8-flash-medium
