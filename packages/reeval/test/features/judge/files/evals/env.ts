import { defineEnvironment } from 'reeval'

/** A README the agent never touches. */
export const app = defineEnvironment('readme-app', { files: { 'README.md': 'Run npm start\n' } })
