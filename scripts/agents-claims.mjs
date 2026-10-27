// Checks on the agents pages for claims the code decides, so a page that says something the
// schemas or the provider table contradict fails `pnpm docs:check` instead of waiting for a judge.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Prose with its code fences removed, split into sentences; each frontmatter line is its own. */
const sentences = (text) =>
  text
    .replace(/^---\n([\s\S]*?)\n---\n/, (_, front) => `${front.split('\n').join('. ')}.\n`)
    .replace(/```[\s\S]*?```/g, '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

/**
 * The problems on docs/configuration/agents:
 *  - a sentence that says every harness takes `effort` while a harness schema has none;
 *  - a sentence that ties `servedModels` to the request URL for some providers only, when the
 *    provider table names the model in the URL for others too;
 *  - an option every harness schema has, missing from "Common harness options" on reference/options or defined on a harness page;
 *  - a harness page with no plugin section or generated plugin block;
 *  - the cell-id default on reference/options with no mention of the last-segment rule `opencode` ids follow;
 *  - the model page holding the harness support matrix instead of linking its home in
 *    reference/options;
 *  - the generated OpenCode provider table on a harness page, or missing from reference/options:
 *    it is a reference catalog, so it lives in Harness behavior and the harness page links to it;
 *  - a heading that two or more harness pages share (`rules`, `skills`, `mcp`, `usage`,
 *    `servedModels`, `web-search`, `web-fetch`): what differs by harness is one entry in
 *    reference/options, and each harness page links to it;
 *  - the landing's `gateway` option written as string literals with no gateway helper, when
 *    harness.ts also takes the `GatewayDescriptor` that `direct()`, `vercel()` and `openrouter()`
 *    return;
 *  - the code block under "Set the harness options" on the landing that does not set every
 *    option the sentence before it names;
 *  - the model page saying `servedModels` records each turn, or not saying it is null for Cursor
 *    and Claude Code (history/types.ts: `servedModels` observes API calls; the per-turn model is
 *    `turns[].model`).
 */
export async function agentsProblems({ root, docsDir }) {
  const problems = []
  const src = join(root, 'packages/reeval/src')
  const { harnessDescriptorSchema } = await import(join(src, 'contract/harness.ts'))
  const { AGENTS } = await import(join(src, 'harness/agents.ts'))
  const { OPENCODE_PROVIDERS } = await import(
    join(root, 'packages/harness-opencode/src/opencode-providers.ts')
  )

  const schemas = harnessDescriptorSchema.options
    .map((o) => ({ kind: o.shape.kind.value, keys: Object.keys(o.shape) }))
    .filter((s) => AGENTS[s.kind])
  const read = (file) => readFileSync(file, 'utf8')
  const landing = join(docsDir, 'configuration/agents/index.mdx')
  const harnessDir = join(docsDir, 'configuration/agents')
  const harnessPages = readdirSync(harnessDir)
    .filter((f) => f.endsWith('.mdx') && f !== 'index.mdx' && f !== 'model.mdx')
    .map((f) => join(harnessDir, f))
  const pages = [landing, join(docsDir, 'configuration/agents/model.mdx'), ...harnessPages]

  const effortless = schemas.filter((s) => !s.keys.includes('effort'))
  const everyHarness = /\b(?:every|each|all)\b[^.]*\b(?:harness(?:es)?|factory|factories)\b/i
  for (const file of pages) {
    for (const sentence of sentences(read(file))) {
      if (!everyHarness.test(sentence) || !/\beffort\b/.test(sentence)) continue
      const unnamed = effortless.filter((s) => !sentence.includes(`\`${AGENTS[s.kind].factory}\``))
      if (unnamed.length) {
        problems.push(
          `${relative(root, file)} says every harness takes effort, but ${unnamed.map((s) => AGENTS[s.kind].factory).join(', ')} has no effort in its schema (contract/harness.ts): name the exception`,
        )
      }
    }
  }

  const urlNamed = OPENCODE_PROVIDERS.filter((p) => p.endpoints.some((e) => 'regex' in e.path)).map(
    (p) => p.id,
  )
  const optionsFile = join(docsDir, 'reference/options.mdx')
  for (const file of [...harnessPages, optionsFile]) {
    for (const sentence of sentences(read(file))) {
      if (!/\brequest URL\b/.test(sentence)) continue
      const named = [...sentence.matchAll(/`([\w.-]+)\/`/g)].map((m) => m[1])
      const left = urlNamed.filter((id) => !named.includes(id))
      if (named.length && left.length) {
        problems.push(
          `${relative(root, file)} ties the served model to the request URL for ${named.join(', ')} only, but providerServedModel (harness-opencode/src/opencode-providers.ts) also reads it from the URL for ${left.join(', ')}: say it of any provider whose model-call path names the model`,
        )
      }
    }
  }

  const providerBlock = '(generated:opencode-providers)'
  for (const file of harnessPages) {
    if (read(file).includes(providerBlock)) {
      problems.push(
        `${relative(root, file)} holds the generated opencode-providers table: it is a reference catalog, so it lives in reference/options (Harness behavior) and the harness page links to it`,
      )
    }
  }
  if (!read(optionsFile).includes(providerBlock)) {
    problems.push('reference/options has no generated opencode-providers block in Harness behavior')
  }

  const optionsText = read(optionsFile)
  const commonSection =
    optionsText.match(/^### Common harness options\n([\s\S]*?)(?=^#{1,3} )/m)?.[1] ?? ''
  if (/\bDefaults to the harness name followed by the model\b/.test(commonSection)) {
    const opencodeRule = sentences(commonSection).some(
      (s) => /`opencode`/.test(s) && /\blast `\/`/.test(s),
    )
    if (!opencodeRule) {
      problems.push(
        "reference/options states the cell-id default (harness name, then model) but not that an opencode id keeps only the part after its last `/` (harnessId in src/options.ts sanitizes with split('/').at(-1))",
      )
    }
  }

  const modelText = read(join(docsDir, 'configuration/agents/model.mdx'))
  const matrixRows = modelText
    .split('\n')
    .filter(
      (l) => l.startsWith('|') && schemas.some((s) => l.includes(`\`${AGENTS[s.kind].factory}\``)),
    )
  if (matrixRows.length) {
    problems.push(
      `agents/model has a table row per harness (${matrixRows.length} rows): the per-harness matrix lives in reference/options#harness-behavior and each harness page, so link to them`,
    )
  }
  if (!modelText.includes('(/reference/options#harness-behavior)')) {
    problems.push(
      'agents/model has no link to /reference/options#harness-behavior, the home of the harness support matrix',
    )
  }

  // Taken by every harness but not yet an entry under "Common harness options".
  const UNDOCUMENTED_COMMON = ['effort']
  const common = schemas
    .map((s) => s.keys)
    .reduce((all, keys) => all.filter((k) => keys.includes(k)))
    .filter((k) => !['kind', 'model'].includes(k))
  for (const key of common) {
    if (!UNDOCUMENTED_COMMON.includes(key) && !commonSection.includes(`<Property name="${key}"`)) {
      problems.push(
        `reference/options has no <Property name="${key}"> under "Common harness options": every harness takes it`,
      )
    }
    for (const file of harnessPages) {
      if (read(file).includes(`<Property name="${key}"`)) {
        problems.push(
          `${relative(root, file)} defines ${key}, which every harness takes: it lives under "Common harness options" on reference/options, so link to it`,
        )
      }
    }
  }

  for (const { kind } of schemas) {
    const file = join(harnessDir, `${kind}.mdx`)
    const text = read(file)
    if (!/^## `plugins`$/m.test(text) || !text.includes(`(generated:harness-plugins:${kind})`)) {
      problems.push(
        `configuration/agents/${kind} needs a plugins section with the generated harness-plugins:${kind} block: plugin support differs by harness`,
      )
    }
  }
  const shared = new Set([
    'rules',
    'skills',
    'mcp',
    'usage',
    'servedmodels',
    'web-search',
    'web-fetch',
  ])
  const homes = new Map()
  for (const file of harnessPages) {
    for (const [, heading] of read(file).matchAll(/^#{2,6} `?([\w-]+)`?\s*$/gm)) {
      const key = heading.toLowerCase()
      if (!shared.has(key)) continue
      homes.set(key, [...(homes.get(key) ?? []), relative(root, file)])
    }
  }
  for (const [heading, files] of homes) {
    if (files.length > 1) {
      problems.push(
        `${files.length} harness pages have a "${heading}" heading (${files.join(', ')}): it is one entry in reference/options, so link to it`,
      )
    }
  }

  const gatewayEntry =
    commonSection.match(/<Property name="gateway"[\s\S]*?<\/Property>/)?.[0] ?? ''
  const helperNamed = /`(?:direct|vercel|openrouter)\(\)`/.test(gatewayEntry)
  if (/type="(?:'\w+'(?: \| )?)+"/.test(gatewayEntry) || !helperNamed) {
    problems.push(
      'reference/options documents the common gateway option as string literals without a gateway helper, but harness.ts also takes a GatewayDescriptor, which direct(), vercel() and openrouter() return: type it GatewayName | GatewayDescriptor and name the helpers',
    )
  }

  const optionsSection =
    read(landing).match(/^## Set the harness options\n([\s\S]*?)```\w*[^\n]*\n([\s\S]*?)\n```/m) ??
    []
  const [, optionsLead = '', optionsCode = ''] = optionsSection
  if (!optionsLead) {
    problems.push('configuration/agents/index has no code block under "Set the harness options"')
  }
  const named = [...optionsLead.matchAll(/`([A-Za-z]\w*)`/g)].map((m) => m[1])
  for (const option of new Set(named)) {
    if (!new RegExp(`^\\s*${option}\\s*:`, 'm').test(optionsCode)) {
      problems.push(
        `configuration/agents/index says to set \`${option}\` under "Set the harness options", but the code block does not set it: add \`${option}: …\` to the factory call`,
      )
    }
  }

  for (const sentence of sentences(modelText)) {
    if (
      /`servedModels`/.test(sentence) &&
      /\b(?:each|every) turn\b/.test(sentence) &&
      !/`turns\[\]\.model`/.test(sentence)
    ) {
      problems.push(
        'agents/model says servedModels records each turn: it is the models the egress gateway observed in API calls (history/types.ts), and the per-turn model is turns[].model',
      )
    }
  }
  for (const sentence of sentences(modelText)) {
    if (/\bharness page\b/i.test(sentence) && /`(?:model|effort)`\s+entry/.test(sentence)) {
      problems.push(
        'agents/model sends the reader to an entry on a harness page for model or effort: the harness pages hold no Property entries, so link to /reference/options#harness-factory-options',
      )
    }
  }
  if (!modelText.includes('(/reference/options#harness-factory-options)')) {
    problems.push('agents/model has no link to /reference/options#harness-factory-options')
  }
  if (
    /`servedModels`/.test(modelText) &&
    !sentences(modelText).some(
      (s) =>
        /`servedModels`/.test(s) && /\bnull\b/.test(s) && /Cursor/.test(s) && /Claude Code/.test(s),
    )
  ) {
    problems.push(
      'agents/model names servedModels but not that it is null for Cursor and Claude Code, whose API requests name no model (history/types.ts)',
    )
  }
  return problems
}
