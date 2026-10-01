import { defineEnvironment, evaluate } from 'reeval'
import { docker } from 'reeval/sandbox'

const withInstall = defineEnvironment('with-install', {
  sandbox: docker({
    install: ['apt-get update && apt-get install -y --no-install-recommends jq'],
  }),
})

const python = defineEnvironment('python', {
  sandbox: docker({ from: 'python:3.12-slim' }),
})

const own = defineEnvironment('own', {
  sandbox: docker({ dockerfile: '../docker/Dockerfile' }),
})

evaluate('config sandbox with install', { environment: withInstall }, async () => {})
evaluate('same sandbox again', { environment: withInstall }, async () => {})
evaluate('toolchain base', { environment: python }, async () => {})
evaluate('own dockerfile', { environment: own }, async () => {})
