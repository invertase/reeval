// One profile per real agent, shared by every example: `pnpm eval --profile <name>`. Each runs in
// Docker (`pnpm reeval image build --profile <name>` once), judges on a model of its own
// provider where there is one, and needs the keys in its comment, in the example's .env.local.
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

const inDocker = (harness: HarnessDescriptor, judge: string): Profile => ({
  defaults: { harness, sandbox: docker() },
  judge: { model: judge },
})

export const profiles = {
  // ANTHROPIC_API_KEY, for the agent and the judge
  'claude-code': inDocker(claudeCode({ model: 'claude-sonnet-5' }), 'anthropic/claude-sonnet-5'),
  // CURSOR_API_KEY, and GOOGLE_GENERATIVE_AI_API_KEY for the judge
  cursor: inDocker(cursor({ model: 'composer-2.5' }), 'google/gemini-3.8-flash'),
  // OPENAI_API_KEY, for the agent and the judge: OpenAI judges with gpt-6-luna, its decision model
  codex: inDocker(codex({ model: 'gpt-5.6-luna' }), 'openai/gpt-6-luna'),
  // GOOGLE_GENERATIVE_AI_API_KEY, for the agent (its model's provider picks the key) and the judge
  opencode: inDocker(opencode({ model: 'google/gemini-3.8-flash' }), 'google/gemini-3.8-flash'),
  // GOOGLE_GENERATIVE_AI_API_KEY, for the agent and the judge
  goose: inDocker(goose({ model: 'gemini-3.8-flash' }), 'google/gemini-3.8-flash'),
  // GOOGLE_GENERATIVE_AI_API_KEY, for the agent and the judge
  pi: inDocker(pi({ model: 'gemini-3.8-flash' }), 'google/gemini-3.8-flash'),
  // GEMINI_API_KEY, and GOOGLE_GENERATIVE_AI_API_KEY for the judge (the same key works for both)
  antigravity: inDocker(
    antigravity({ model: 'gemini-3.8-flash-medium' }),
    'google/gemini-3.8-flash',
  ),
  // AI_GATEWAY_API_KEY, for the agent and the judge: fx runs a gateway id like this one only
  // through Vercel AI Gateway, which serves Jev as a judge but no language model
  fx: {
    ...inDocker(fx({ model: 'anthropic/claude-sonnet-5' }), 'typesafe-ai/jev-1.14.0'),
    gateway: [vercel()],
  },
  // XAI_API_KEY, and GOOGLE_GENERATIVE_AI_API_KEY for the judge
  'grok-build': inDocker(grokBuild({ model: 'grok-4.6' }), 'google/gemini-3.8-flash'),
} satisfies Record<string, Profile>
