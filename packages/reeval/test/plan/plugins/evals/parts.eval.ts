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

evaluate('every part', { environment: review }, async () => {})
evaluate('only skills and mcp', { environment: narrowed }, async () => {})
evaluate('child replaces the review plugin', { environment: lite }, async () => {})
