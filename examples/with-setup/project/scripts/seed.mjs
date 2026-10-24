import { mkdirSync, writeFileSync } from 'node:fs'

const users = Array.from({ length: 100 }, (_, i) => ({
  id: i + 1,
  name: `user-${i + 1}`,
  active: i % 4 === 0,
}))
mkdirSync('data', { recursive: true })
writeFileSync('data/users.json', `${JSON.stringify(users, null, 2)}\n`)
