// Writes pi's models.json for a model on an AI gateway, run in the sandbox before each turn, with
// the model in a provider of reeval's. An Anthropic model goes on the gateway's Anthropic Messages
// API and any other on its Chat Completions API. Its thinking levels, limits and prices are pi's
// catalog entry for it, on the gateway or its provider, else the host's description of it. A
// Gemini model's thinking level goes as the gateway's native Gemini `thinkingConfig`, so the model
// gets the level pi sends it there.
//
// node gateway-models.mjs <bootstrap dir> <models.json> <gateway json> <model> <model info json>
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [bootstrapDir, out, gatewayJson, model, infoJson] = process.argv.slice(2)
const gateway = JSON.parse(gatewayJson)
const info = JSON.parse(infoJson ?? 'null')
const fail = (why) => {
  process.stderr.write(`reeval: ${why}\n`)
  process.exit(1)
}

// pnpm puts pi's own dependencies beside it, so pi-ai is pi-coding-agent's sibling.
const agent = realpathSync(join(bootstrapDir, 'node_modules/@earendil-works/pi-coding-agent'))
const data = join(dirname(agent), 'pi-ai/dist/providers/data')
/** The chat models of one of pi's catalogs, whatever API each is on. */
const catalog = (name) => {
  const file = join(data, `${name}.json`)
  if (!/^[\w-]+$/.test(name) || !existsSync(file)) return []
  return Object.values(JSON.parse(readFileSync(file, 'utf8'))).flatMap((models) =>
    Object.entries(models)
      .filter(([key]) => key.startsWith('chat:'))
      .map(([, m]) => m),
  )
}

const slash = model.indexOf('/')
const provider = slash < 0 ? '' : model.slice(0, slash)
const id = model.slice(slash + 1)
const gemini = provider === 'google'

let entry
if (gemini) {
  entry = catalog('google').find((m) => m.id === id)
  if (!entry)
    fail(`pi's catalog has no Gemini model ${id}, so pi can't run ${model} on ${gateway.name}`)
  if (entry.reasoning && !entry.thinkingLevelMap) {
    fail(
      `${id} takes a thinking budget, not a thinking level, so pi can't run it on ${gateway.name}`,
    )
  }
} else {
  // A provider's own catalog names a version with a dash where a gateway dots it (claude-haiku-4-5).
  const dashed = id.replace(/(\d)\.(\d)/g, '$1-$2')
  entry =
    catalog(gateway.catalog).find((m) => m.id === model) ??
    catalog(provider).find((m) => m.id === id || m.id === dashed) ??
    info ??
    fail(
      `neither pi's catalog nor models.dev describes ${model}, so pi can't run it on ${gateway.name}`,
    )
}

const thinking = (level) => ({ thinkingConfig: { thinkingLevel: level, includeThoughts: true } })
const byLevel = {}
for (const level of gemini && entry.reasoning ? ['minimal', 'low', 'medium', 'high'] : []) {
  const mapped = entry.thinkingLevelMap[level]
  if (mapped === null) continue
  const native = (typeof mapped === 'string' ? mapped : level).toLowerCase()
  byLevel[level] = {
    providerOptions: Object.fromEntries(gateway.gemini.upstreams.map((u) => [u, thinking(native)])),
  }
}

const anthropic = provider === 'anthropic'
const models = {
  providers: {
    [gateway.id]: {
      name: gateway.name,
      baseUrl: anthropic ? gateway.anthropic : gateway.openai,
      api: anthropic ? 'anthropic-messages' : 'openai-completions',
      apiKey: `$${gateway.credentialEnv}`,
      authHeader: true,
      compat: {
        // A Gemini model's level goes as the thinkingConfig above; the gateway's shared effort
        // field would map Gemini's levels onto its own.
        ...(gemini ? { supportsReasoningEffort: false } : {}),
        supportsStore: false,
        supportsDeveloperRole: false,
      },
      models: [
        {
          id: model,
          ...(entry.name ? { name: entry.name } : {}),
          reasoning: entry.reasoning,
          ...(entry.thinkingLevelMap ? { thinkingLevelMap: entry.thinkingLevelMap } : {}),
          input: entry.input,
          ...(entry.cost ? { cost: entry.cost } : {}),
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
