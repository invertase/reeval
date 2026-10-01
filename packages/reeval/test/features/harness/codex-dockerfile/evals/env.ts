import { defineEnvironment } from 'reeval'
import { docker } from 'reeval/sandbox'

export const plain = defineEnvironment('plain', {
  sandbox: docker({ dockerfile: '../docker/Dockerfile', id: 'docker' }),
})
