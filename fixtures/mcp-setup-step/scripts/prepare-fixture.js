import { mkdirSync, writeFileSync } from 'node:fs'

const users = [{ name: 'Ada' }, { name: 'Grace' }, { name: 'Linus' }]
mkdirSync('data', { recursive: true })
writeFileSync('data/users.json', `${JSON.stringify(users, null, 2)}\n`)
