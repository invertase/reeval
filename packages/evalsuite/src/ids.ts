import { createHash } from 'node:crypto'
import { relative, sep } from 'node:path'

export const relativeFile = (root: string, file: string) =>
  relative(root, file).split(sep).join('/')

export const evalId = (file: string, name: string) => `${file} › ${name}`

export const recordFileName = (id: string) =>
  `${createHash('sha256').update(id).digest('hex').slice(0, 16)}.json`

export const newRunId = () =>
  `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}-${Math.random().toString(36).slice(2, 8)}`
