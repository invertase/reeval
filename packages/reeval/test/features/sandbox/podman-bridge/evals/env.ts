import { execFileSync } from 'node:child_process'
import { defineEnvironment } from 'reeval'
import { podman } from 'reeval/sandbox'

export const bridged = defineEnvironment('bridged', { sandbox: podman() })

/** The sandbox's own IPv4 addresses, loopback aside. */
export const ADDRESSES = `awk '/32 host/ {print f} {f=$2}' /proc/net/fib_trie | sort -u | grep -v '^127\\.'`

/** The subnets of Podman's `podman` bridge network, read on the host. */
export const bridgeSubnets = () =>
  execFileSync(
    'podman',
    ['network', 'inspect', 'podman', '--format', '{{range .Subnets}}{{.Subnet}} {{end}}'],
    {
      encoding: 'utf8',
    },
  )
    .trim()
    .split(/\s+/)

const toInt = (ip: string) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0)

/** The addresses inside any of the IPv4 `subnets`. */
export const within = (addresses: string[], subnets: string[]) =>
  addresses.filter((a) =>
    subnets.some((s) => {
      const [net = '', bits = '32'] = s.split('/')
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(net)) return false
      const size = 2 ** (32 - Number(bits))
      return Math.floor(toInt(a) / size) === Math.floor(toInt(net) / size)
    }),
  )
