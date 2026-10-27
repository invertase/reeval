// Holds each routing gateway page to naming every model call reeval routes, so a page that stops
// after the judge fails `pnpm docs:check` instead of waiting for a judge.
import { readFileSync } from 'node:fs'
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
  return problems
}
