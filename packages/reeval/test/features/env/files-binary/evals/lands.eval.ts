import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { evaluate, expect } from 'reeval'
import { binaryFile, hostBlob, sandboxSha256 } from './env.ts'

// A host `file()` lands byte for byte.
evaluate('lands', { environment: binaryFile }, async (c) => {
  const onHost = createHash('sha256').update(readFileSync(hostBlob)).digest('hex')
  expect((await c.exec(sandboxSha256)).stdout).toBe(onHost)
})
