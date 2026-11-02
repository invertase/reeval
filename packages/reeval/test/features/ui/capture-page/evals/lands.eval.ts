import { evaluate, expect } from 'reeval'
import { ui } from './env.ts'

evaluate('lands', { environments: ui }, async (c) => {
  const server = await c.serve('node server.mjs')
  const shot = await c.capture(server, { name: 'home', path: '/sign-up' })
  expect(shot).toHaveStatus(200)
  expect(shot.finalUrl).toBe('/sign-up')
  expect(shot.errors.map((e) => e.split('\n')[0])).toEqual([
    'Uncaught Error: late failure',
    'Uncaught (in promise) Error: no session',
  ])
  expect(shot.console.filter((m) => m.source === 'console-api')).toEqual([
    { level: 'log', text: 'rendered', source: 'console-api', url: '/sign-up' },
    { level: 'warning', text: 'auth is not configured', source: 'console-api', url: '/sign-up' },
  ])
  expect(shot.failedRequests).toEqual([{ method: 'GET', url: '/missing.js', status: 404 }])
})
