const token = process.env.GITHUB_TOKEN
const res = await fetch('https://api.github.com/repos/nodejs/node', {
  headers: token ? { authorization: `Bearer ${token}` } : {},
})
if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
console.log((await res.json()).description)
