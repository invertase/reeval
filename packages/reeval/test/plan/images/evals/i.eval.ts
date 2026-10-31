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

evaluate('config sandbox with install', { environments: withInstall }, async () => {})
evaluate('same sandbox again', { environments: withInstall }, async () => {})
evaluate('toolchain base', { environments: python }, async () => {})
evaluate('own dockerfile', { environments: own }, async () => {})
