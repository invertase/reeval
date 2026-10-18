import { readFileSync } from 'node:fs'

export const parseConfig = (path) => JSON.parse(readFileSync(path, 'utf8'))
