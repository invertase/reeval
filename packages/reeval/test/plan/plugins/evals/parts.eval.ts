import { defineEnvironment, evaluate } from 'reeval'

const review = defineEnvironment('review', ({ plugin }) => ({
  plugins: [plugin.local('../plugins/review')],
}))
const narrowed = defineEnvironment('narrowed', ({ plugin }) => ({
  plugins: [plugin.local('../plugins/review', { only: ['skills', 'mcp'] })],
}))
const lite = review.extend('lite', ({ plugin }) => ({
  plugins: [plugin.local('../plugins/review-lite')],
}))
const fetched = defineEnvironment('fetched', ({ plugin }) => ({
  plugins: [
    plugin.git('github:acme/agent-plugins', { ref: 'v1.2.0', path: 'plugins/review' }),
    plugin.npm('@acme/review-plugin@1.2.0', { only: ['skills'] }),
  ],
}))

evaluate('every part', { environment: review }, async () => {})
evaluate('only skills and mcp', { environment: narrowed }, async () => {})
evaluate('child replaces the review plugin', { environment: lite }, async () => {})
evaluate('git and npm read at the attempt', { environment: fetched }, async () => {})
