import { users } from './users.js'

// GET /users?page=1&pageSize=20
export function listUsers(query) {
  const page = Number(query.page ?? 1)
  const pageSize = Number(query.pageSize ?? 20)
  const start = (page - 1) * pageSize
  return {
    status: 200,
    body: { users: users.slice(start, start + pageSize), page, total: users.length },
  }
}
