// One profile per real agent, shared by every example: `pnpm eval --profile <name>`. Each runs in
// Docker (`pnpm reeval image build --profile <name>` once) and needs the key in its comment, in
// the example's .env.local.
import type { Profile } from 'reeval'
import { vercel } from 'reeval/gateway'
import type { HarnessDescriptor } from 'reeval/harness'
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
import { docker } from 'reeval/sandbox'

const inDocker = (harness: HarnessDescriptor): Profile => ({
  defaults: { harness, sandbox: docker() },
})

export const profiles = {
  // ANTHROPIC_API_KEY
  'claude-code': inDocker(claudeCode({ model: 'claude-sonnet-5' })),
  // CURSOR_API_KEY
  cursor: inDocker(cursor({ model: 'composer-2.5' })),
  // OPENAI_API_KEY
  codex: inDocker(codex({ model: 'gpt-5.6-luna' })),
  // GOOGLE_GENERATIVE_AI_API_KEY (the model's provider picks the key)
  opencode: inDocker(opencode({ model: 'google/gemini-3.8-flash' })),
  // GOOGLE_GENERATIVE_AI_API_KEY
  goose: inDocker(goose({ model: 'gemini-3.8-flash' })),
  // GOOGLE_GENERATIVE_AI_API_KEY
  pi: inDocker(pi({ model: 'gemini-3.8-flash' })),
  // GEMINI_API_KEY
  antigravity: inDocker(antigravity({ model: 'gemini-3.8-flash-medium' })),
  // AI_GATEWAY_API_KEY: fx runs a gateway id like this one only through Vercel AI Gateway
  fx: { ...inDocker(fx({ model: 'anthropic/claude-sonnet-5' })), gateway: [vercel()] },
  // XAI_API_KEY
  'grok-build': inDocker(grokBuild({ model: 'grok-4.6' })),
} satisfies Record<string, Profile>
