// Holds each routing gateway page to naming every model call reeval routes, so a page that stops
// after the judge fails `pnpm docs:check` instead of waiting for a judge.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PAGES = ['direct', 'vercel', 'openrouter']
const SLOTS = [
  ['judge', /\bjudges?\b/i],
  ['analysis', /\banalysis\b/i],
  ['captures', /\bcaptures?\b/i],
  ['questions', /\bquestions?\b/i],
]

/** The prose of a page's "Harnesses and models" section, without code fences. */
export function modelsSection(text) {
  const match = text.match(/^## Harnesses and models\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)
  return match ? match[1].replace(/```[\s\S]*?```/g, '') : ''
}

/** Problems on docs/integrations/gateways: a routing gateway's models section must name the judge, analysis, captures and questions, or say it refuses them. */
export function gatewayModelProblems(docsDir) {
  const problems = []
  for (const name of PAGES) {
    const file = `integrations/gateways/${name}`
    const section = modelsSection(readFileSync(join(docsDir, `${file}.mdx`), 'utf8'))
    const sentences = section.split(/(?<=[.!?])\s+/)
    for (const [slot, pattern] of SLOTS) {
      if (!sentences.some((s) => pattern.test(s))) {
        problems.push(
          `${file} "Harnesses and models" never names the ${slot} model: say which models ${name}() routes for the judge, analysis, captures and questions, or which of them it does not`,
        )
      }
    }
  }
  problems.push(...gatewayNotesProblems(docsDir))
  problems.push(...gatewayPropertyProblems(docsDir))
  return problems
}

/** Problems on docs/integrations/gateways: a gateway page is a task page, so a `<Property` entry belongs on reference/options. */
export function gatewayPropertyProblems(docsDir) {
  const problems = []
  const dir = join(docsDir, 'integrations/gateways')
  for (const entry of readdirSync(dir).filter((f) => f.endsWith('.mdx'))) {
    const file = `integrations/gateways/${entry.replace(/\.mdx$/, '')}`
    const text = readFileSync(join(dir, entry), 'utf8')
    if (/<Property\b/.test(text)) {
      problems.push(
        `${file} has a <Property> entry: gateway pages are task pages, so move the option's entry to reference/options and link it`,
      )
    }
  }
  return problems
}

const FENCE = /^```(\w+)[^\n]*\n([\s\S]*?)^```/gm

/** The harness factories `reeval/harness` exports, read from its source. */
function harnessFactories(root) {
  const source = readFileSync(join(root, 'packages/reeval/src/harness.ts'), 'utf8')
  return [...source.matchAll(/^export const (\w+) = /gm)].map((m) => m[1])
}

/** Problems on docs/agents/gateways: a `gateway:` notes block names a gateway for every harness factory in the config block before it. */
export function gatewayNotesProblems(docsDir) {
  const problems = []
  const file = 'agents/gateways'
  const text = readFileSync(join(docsDir, `${file}.mdx`), 'utf8')
  const factories = harnessFactories(join(docsDir, '..'))
  let config
  for (const [, lang, body] of text.matchAll(FENCE)) {
    if (lang === 'ts' && /\bharness:\s*\[/.test(body)) config = body
    if (lang !== 'text' || !config) continue
    const notes = [...body.matchAll(/gateway: \S+ → \w+/g)].length
    if (!notes) continue
    const calls = config
      .split('\n')
      .filter((line) => !/^\s*import\b/.test(line))
      .join('\n')
    const harnesses = factories.reduce(
      (n, name) => n + [...calls.matchAll(new RegExp(`\\b${name}\\(`, 'g'))].length,
      0,
    )
    if (notes < harnesses) {
      problems.push(
        `${file} shows ${notes} \`gateway:\` notes for the ${harnesses} harness factories in its config block: the plan prints one note per harness, in the order of \`harness\``,
      )
    }
  }
  return problems
}
