import { defineEnvironment } from 'reeval'

export const plain = defineEnvironment('plain', {})
export const marked = defineEnvironment('marked', { files: { 'marker.txt': 'ok\n' } })
