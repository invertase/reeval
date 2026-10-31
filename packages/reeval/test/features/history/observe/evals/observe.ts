import type { AttemptContext } from 'reeval'

/** What the agent installed, observed before and after its turn; `orm` is observed twice. */
export async function observeInstall(c: AttemptContext): Promise<Record<string, string>> {
  c.observe('orm', 'none yet')
  await c.send('add a database layer')
  const deps: Record<string, string> =
    JSON.parse((await c.readFile('package.json')) ?? '{}').dependencies ?? {}
  c.observe('deps', Object.keys(deps))
  c.observe('orm', deps['drizzle-orm'] ? 'drizzle' : 'other')
  c.observe('dep-count', Object.keys(deps).length)
  return deps
}
