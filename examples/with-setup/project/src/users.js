import { readFileSync } from 'node:fs'

export function loadUsers(path = 'data/users.json') {
  return JSON.parse(readFileSync(path, 'utf8'))
}
