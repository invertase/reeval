import { users } from './users.js'

const error = (code, message) => ({ status: 400, body: { error: { code, message } } })

// GET /users?limit=20&cursor=<nextCursor>
export function listUsers(query) {
  const limit = query.limit === undefined ? 20 : Number(query.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return error('invalid_limit', 'The limit must be a whole number from 1 to 100.')
  }

  let start = 0
  if (query.cursor !== undefined) {
    const after = Buffer.from(query.cursor, 'base64url').toString()
    const index = users.findIndex((user) => user.id === after)
    if (index === -1) return error('invalid_cursor', 'The cursor is not valid.')
    start = index + 1
  }

  const data = users.slice(start, start + limit)
  const last = data.at(-1)
  const more = start + limit < users.length
  const nextCursor = more && last ? Buffer.from(last.id).toString('base64url') : null
  return { status: 200, body: { data, nextCursor } }
}
