// What api.eval.ts's starter needs beyond create-next-app's API template, and the check that
// calls the built route. The template has no package.json (create-next-app writes one), so this
// is the one it would write, pinned.

const packageJson = {
  name: 'users-api',
  version: '0.1.0',
  private: true,
  scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
  dependencies: { next: '16.3.7', react: '19.3.0', 'react-dom': '19.3.0' },
  devDependencies: {
    '@types/node': '22.20.4',
    '@types/react': '19.3.0',
    typescript: '5.9.3',
  },
}

const names = ['Ada', 'Grace', 'Alan', 'Barbara', 'Edsger', 'Frances', 'Ken', 'Margaret', 'Tim']
const users = Array.from({ length: 45 }, (_, i) => {
  const name = `${names[i % names.length]} ${Math.floor(i / names.length) + 1}`
  const id = `u_${String(i + 1).padStart(3, '0')}`
  return { id, name, email: `${id}@example.com` }
})

const usersModule = `export type User = { id: string; name: string; email: string }

export const users: User[] = ${JSON.stringify(users, null, 2)}
`

/** The package.json create-next-app would write, and the users the endpoint lists. */
export const appFiles = {
  'package.json': `${JSON.stringify(packageJson, null, 2)}\n`,
  'lib/users.ts': usersModule,
}

const probe = `
const port = 3107
const { spawn } = await import('node:child_process')
const server = spawn('npx', ['next', 'start', '-p', String(port)], { stdio: 'ignore', detached: true })
const fail = (why, got) => {
  console.error(why + (got === undefined ? '' : ': ' + JSON.stringify(got)))
  process.exitCode = 1
  throw new Error(why)
}
async function get(query) {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/api/users' + query)
      const text = await res.text()
      try {
        return { status: res.status, body: JSON.parse(text) }
      } catch {
        fail('GET /api/users' + query + ' answered ' + res.status + ' with no JSON', text.slice(0, 200))
      }
    } catch (error) {
      if (process.exitCode) throw error
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  fail('next start never answered on port ' + port)
}
try {
  const first = await get('?limit=2')
  if (first.status !== 200) fail('GET ?limit=2 should be 200', first)
  const keys = Object.keys(first.body).sort().join(',')
  if (keys !== 'data,nextCursor') fail('the body should be exactly { data, nextCursor }', first.body)
  if (!Array.isArray(first.body.data) || first.body.data.length !== 2) fail('limit=2 should return 2 items', first.body)
  if (typeof first.body.nextCursor !== 'string') fail('nextCursor should be a string before the last page', first.body)
  const ids = new Set()
  let cursor = null
  for (let page = 0; page < 50; page++) {
    const res = await get('?limit=10' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
    if (res.status !== 200) fail('following nextCursor should stay 200', res)
    for (const user of res.body.data) ids.add(user.id)
    cursor = res.body.nextCursor
    if (cursor === null) break
  }
  if (cursor !== null) fail('nextCursor should be null on the last page')
  if (ids.size !== 45) fail('following nextCursor should list all 45 users once', ids.size)
  const bad = await get('?cursor=not-a-real-cursor')
  if (bad.status !== 400) fail('a bad cursor should be 400', bad)
  const error = bad.body.error
  if (Object.keys(bad.body).join(',') !== 'error' || error?.code !== 'invalid_cursor' || typeof error?.message !== 'string') {
    fail('a bad cursor should answer { error: { code: "invalid_cursor", message } }', bad.body)
  }
  console.log('GET /api/users pages by cursor and reports invalid_cursor')
} finally {
  process.kill(-server.pid)
}
`

/** Starts the built app and calls GET /api/users: the page shape, every page, a bad cursor. */
export const probeUsers = `cat > /tmp/probe-users.mjs <<'EOF'${probe}EOF
node /tmp/probe-users.mjs`
