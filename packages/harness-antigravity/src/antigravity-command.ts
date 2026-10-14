import type { HarnessV1PermissionMode } from '@ai-sdk/harness'
import { shellQuote } from '@ai-sdk/harness/utils'

/** Values `agy --effort` takes; the CLI names them, not a shared enum. */
export type AntigravityEffort = string

export type AntigravityCommandOptions = {
  cli: string
  workDir: string
  /** A file holding the prompt: print mode takes it as `-p`'s value, never from stdin. */
  promptFile: string
  model?: string | undefined
  effort?: AntigravityEffort | undefined
  permissionMode?: HarnessV1PermissionMode | undefined
  conversationId?: string | undefined
  jsonSchemaFile?: string | undefined
}

/**
 * `allow-all` skips every approval. The CLI can't ask in print mode, so anything it would ask
 * about is declined: `allow-edits` still edits (`accept-edits`) and `allow-reads` plans only.
 */
const PERMISSION_FLAGS: Record<HarnessV1PermissionMode, string[]> = {
  'allow-all': ['--dangerously-skip-permissions'],
  'allow-edits': ['--mode', 'accept-edits'],
  'allow-reads': ['--mode', 'plan'],
}

/**
 * One headless turn: NDJSON events on stdout, the workspace added explicitly (without it, print
 * mode can write into a scratch directory), slash commands off so a prompt starting with `/` is
 * sent as text, and no print timeout (the caller owns cancellation). `-p` comes last.
 */
export function buildAntigravityCommand(o: AntigravityCommandOptions): string {
  const args = [
    '--output-format',
    'stream-json',
    '--add-dir',
    o.workDir,
    '--disable-slash-commands',
    '--print-timeout',
    '0',
    ...(o.model ? ['--model', o.model] : []),
    ...(o.effort ? ['--effort', o.effort] : []),
    ...PERMISSION_FLAGS[o.permissionMode ?? 'allow-all'],
    ...(o.conversationId ? ['--conversation', o.conversationId] : []),
    ...(o.jsonSchemaFile ? ['--json-schema', o.jsonSchemaFile] : []),
  ]
  return `exec ${[o.cli, ...args].map(shellQuote).join(' ')} -p "$(cat ${shellQuote(o.promptFile)})"`
}
