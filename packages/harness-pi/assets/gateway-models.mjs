// Writes pi's models.json for a Gemini model on an AI gateway's Chat Completions API, run in the
// sandbox before each turn: pi's own catalog entry for the model (its thinking levels, limits and
// prices, as on Gemini's API), with each thinking level sent as the gateway's native Gemini
// `thinkingConfig`, so the model gets the level pi sends it there.
//
// node gateway-models.mjs <bootstrap dir> <models.json> <provider json> <model>
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [bootstrapDir, out, providerJson, model] = process.argv.slice(2)
const provider = JSON.parse(providerJson)
const fail = (why) => {
  process.stderr.write(`reeval: ${why}\n`)
  process.exit(1)
}

// pnpm puts pi's own dependencies beside it, so pi-ai is pi-coding-agent's sibling.
const agent = realpathSync(join(bootstrapDir, 'node_modules/@earendil-works/pi-coding-agent'))
const catalog = JSON.parse(
  readFileSync(join(dirname(agent), 'pi-ai/dist/providers/data/google.json'), 'utf8'),
)
const id = model.replace(/^google\//, '')
const entry = Object.values(catalog['google-generative-ai'] ?? {}).find((m) => m.id === id)
if (!entry)
  fail(`pi's catalog has no Gemini model ${id}, so pi can't run ${model} on ${provider.name}`)
if (entry.reasoning && !entry.thinkingLevelMap) {
  fail(
    `${id} takes a thinking budget, not a thinking level, so pi can't run it on ${provider.name}`,
  )
}

const thinking = (level) => ({ thinkingConfig: { thinkingLevel: level, includeThoughts: true } })
const byLevel = {}
for (const level of entry.reasoning ? ['minimal', 'low', 'medium', 'high'] : []) {
  const mapped = entry.thinkingLevelMap[level]
  if (mapped === null) continue
  const native = (typeof mapped === 'string' ? mapped : level).toLowerCase()
  byLevel[level] = {
    providerOptions: Object.fromEntries(provider.upstreams.map((u) => [u, thinking(native)])),
  }
}

const models = {
  providers: {
    [provider.id]: {
      name: provider.name,
      baseUrl: provider.baseUrl,
      api: 'openai-completions',
      apiKey: `$${provider.credentialEnv}`,
      // Each level goes as the native thinkingConfig above; the gateway's shared effort field
      // would map Gemini's levels onto its own.
      compat: {
        supportsReasoningEffort: false,
        supportsStore: false,
        supportsDeveloperRole: false,
      },
      models: [
        {
          id: model,
          name: entry.name,
          reasoning: entry.reasoning,
          ...(entry.thinkingLevelMap ? { thinkingLevelMap: entry.thinkingLevelMap } : {}),
          input: entry.input,
          cost: entry.cost,
          contextWindow: entry.contextWindow,
          maxTokens: entry.maxTokens,
          ...(Object.keys(byLevel).length ? { samplingParamsByThinkingLevel: byLevel } : {}),
        },
      ],
    },
  },
}
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(models, null, 2)}\n`)
