// The harnesses the examples use, defined once so the config, evals and profile limits share them.
import { antigravity, claudeCode, cursor, goose, opencode } from 'evalsuite/harness'

// `fast: 'true'` is the variant Cursor's catalog marks as the default; unset, the SDK takes `false`.
export const composer = cursor({ model: 'composer-2.5', params: { fast: 'true' } }) // id cursor:composer-2.5
export const claude = claudeCode({ model: 'claude-sonnet-5' }) // id claude-code:claude-sonnet-5
export const agy = antigravity({ model: 'gemini-3.8-flash-medium' }) // id antigravity:gemini-3.8-flash-medium
export const oc = opencode({ model: 'gemini-3.8-flash' }) // id opencode:gemini-3.8-flash
export const gs = goose({ model: 'gemini-3.8-flash' }) // id goose:gemini-3.8-flash
