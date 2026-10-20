import { defineEnvironment, evaluate } from 'reeval'
import { docker, podman } from 'reeval/sandbox'

const onDocker = defineEnvironment('on-docker', { sandbox: docker() })
const onPodman = defineEnvironment('on-podman', { sandbox: podman() })
const podman22 = defineEnvironment('podman22', {
  sandbox: podman({ from: 'node:22-bookworm', memory: '2g' }),
})
const tools = defineEnvironment('tools', {
  sandbox: podman({
    from: 'node:22-bookworm',
    install: ['apt-get update && apt-get install -y jq'],
  }),
})

evaluate('docker', { environment: onDocker }, async () => {})
evaluate('podman', { environment: onPodman }, async () => {})
evaluate('podman from', { environment: podman22 }, async () => {})
evaluate('podman install', { environment: tools }, async () => {})
