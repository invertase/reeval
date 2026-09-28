import { evaluate } from 'reeval'
import { skilled, terse } from './envs.ts'

evaluate('two variants', { compare: { variants: [skilled, terse] } }, async () => {})
evaluate('one variant', { compare: { variants: [skilled] } }, async () => {})
evaluate('pinned', { compare: { variants: [skilled, terse] }, pin: ['compare'] }, async () => {})
