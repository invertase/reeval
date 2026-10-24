const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
  headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY },
})
if (!res.ok) throw new Error(`Gemini answered ${res.status}`)
const { models } = await res.json()
console.log(`${models.length} models`)
