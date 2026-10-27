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
 * The problems on docs/agents and docs/integrations/agents:
 *  - a sentence that says every harness takes `effort` while a harness schema has none;
 *  - a sentence that ties `servedModels` to the request URL for some providers only, when the
 *    provider table names the model in the URL for others too;
 *  - an option every harness schema has, defined on a harness page instead of the landing;
 *  - a harness page with no plugin section or generated plugin block;
 *  - a heading that two or more harness pages share (`rules`, `skills`, `mcp`, `usage`,
 *    `servedModels`, `web-search`, `web-fetch`): what differs by harness is one entry in
 *    reference/options, and each harness page links to it.
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
  const landing = join(docsDir, 'agents/index.mdx')
  const harnessDir = join(docsDir, 'integrations/agents')
  const harnessPages = readdirSync(harnessDir)
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => join(harnessDir, f))
  const pages = [landing, join(docsDir, 'agents/model.mdx'), ...harnessPages]

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
  for (const file of harnessPages) {
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

  const common = schemas
    .map((s) => s.keys)
    .reduce((all, keys) => all.filter((k) => keys.includes(k)))
    .filter((k) => !['kind', 'model'].includes(k))
  for (const key of common) {
    if (!read(landing).includes(`<Property name="${key}"`)) {
      problems.push(`agents/index has no <Property name="${key}">: every harness takes it`)
    }
    for (const file of harnessPages) {
      if (read(file).includes(`<Property name="${key}"`)) {
        problems.push(
          `${relative(root, file)} defines ${key}, which every harness takes: it lives on agents/index, so link to it`,
        )
      }
    }
  }

  for (const { kind } of schemas) {
    const file = join(harnessDir, `${kind}.mdx`)
    const text = read(file)
    if (!/^## `plugins`$/m.test(text) || !text.includes(`(generated:harness-plugins:${kind})`)) {
      problems.push(
        `integrations/agents/${kind} needs a plugins section with the generated harness-plugins:${kind} block: plugin support differs by harness`,
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
  return problems
}
