import { defineEnvironment, evaluate } from 'reeval'

// Antigravity installs a plugin whole and Cursor takes it unpacked, so both keep every part.
const review = defineEnvironment('review', ({ plugin }) => ({
  plugins: [plugin.local('../plugins/review')],
}))

evaluate('loads the plugin', { environment: review }, async () => {})
