import { evaluate } from 'evalsuite'
import { skilled, terse } from './envs.ts'

evaluate('two variants', { compare: [skilled, terse] }, async () => {})
evaluate('one variant', { compare: [skilled] }, async () => {})
evaluate('pinned', { compare: [skilled, terse], pin: ['compare'] }, async () => {})
