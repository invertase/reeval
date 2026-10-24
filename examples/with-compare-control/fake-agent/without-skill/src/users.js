const users = [
  { id: 'u1', name: 'Ada' },
  { id: 'u2', name: 'Grace' },
  { id: 'u3', name: 'Linus' },
  { id: 'u4', name: 'Margaret' },
  { id: 'u5', name: 'Dennis' },
]

export function listUsers({ offset = 0, limit = 10 } = {}) {
  const next = offset + limit
  return { users: users.slice(offset, next), next: next < users.length ? next : null }
}
