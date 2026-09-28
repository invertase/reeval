import { defineEnvironment } from 'evalsuite'

export const plain = defineEnvironment('plain', {})

export const prompt = "Don't run any tools. Reply with the word ok."
