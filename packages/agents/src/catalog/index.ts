// Every real agent's harness, by kind: one file each.

import { antigravity } from './antigravity.ts'
import { claudeCode } from './claude-code.ts'
import { codex } from './codex.ts'
import { cursor } from './cursor.ts'
import type { AgentKind, HarnessCatalogEntry } from './entry.ts'
import { fx } from './fx.ts'
import { goose } from './goose.ts'
import { grokBuild } from './grok-build.ts'
import { opencode } from './opencode.ts'
import { pi } from './pi.ts'

/** Every real agent's harness, by kind. */
export const HARNESSES = {
  cursor: cursor,
  'claude-code': claudeCode,
  antigravity: antigravity,
  opencode: opencode,
  goose: goose,
  pi: pi,
  codex: codex,
  fx: fx,
  'grok-build': grokBuild,
} satisfies Record<AgentKind, HarnessCatalogEntry>
