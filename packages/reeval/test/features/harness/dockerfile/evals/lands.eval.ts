import { evaluate, expect } from 'reeval'
import { harnessCli } from '../layout.ts'
import { plain } from './env.ts'

// A Dockerfile FROM ${REEVAL_BASE} is built on the harness's image, so its CLI is there.
evaluate('lands', { environment: plain }, async (c) => {
  const found = await c.exec(harnessCli.find)
  expect(found.stdout.trim()).toMatch(new RegExp(`/${harnessCli.name}$`))
  if (!harnessCli.version) return
  const version = await c.exec(`'${found.stdout.trim()}' --version`)
  expect(version.stdout.trim()).toMatch(harnessCli.version)
})
