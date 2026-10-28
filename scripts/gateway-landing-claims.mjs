// Holds the gateways landing's harness-support sentence to the exceptions `direct()` has, so a page
// that says it serves every harness without them fails `pnpm docs:check` instead of waiting for a judge.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const prose = (text) => text.replace(/```[\s\S]*?```/g, '')

/** Problems in the landing's text: `direct()` serving every harness with no `fx` gateway-id or OpenCode provider exception. */
export function directExceptionProblems(text, file = 'docs/configuration/gateways/index.mdx') {
  const claim = /`direct\(\)` serves every harness[\s\S]*?(?=This table|\n\n)/.exec(prose(text))
  if (!claim) return []
  const missing = []
  if (!/\bfx\b[^.]*gateway (?:model )?id/i.test(claim[0]))
    missing.push('the `fx` gateway-id exception')
  if (!/OpenCode[^.]*provider/i.test(claim[0])) missing.push('the OpenCode provider exception')
  return missing.length
    ? [
        `${file} says direct() serves every harness without naming ${missing.join(' or ')}: gateway/resolve.ts refuses fx with a gateway model id and an OpenCode model whose provider reeval can't run`,
      ]
    : []
}

export function gatewayLandingProblems(docsDir) {
  const file = join(docsDir, 'configuration/gateways/index.mdx')
  return directExceptionProblems(
    readFileSync(file, 'utf8'),
    'docs/configuration/gateways/index.mdx',
  )
}
