// An SSH VM in a container, for the fakes of providers whose machines are Linux VMs reached over
// SSH (Boat's and Daytona's): sshd, a login user with passwordless sudo, and a Node where that
// provider's VMs have it.
// Each container is labeled with its VM's name, so a test can look into one from outside.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { connect } from 'node:net'
import { NODE_IMAGE } from '../../../sandbox-docker/src/build-image.ts'

/** Where one fake VM's SSH server is, and how to let a key in. */
export type SshVm = {
  /** `host:port`, as Boat's `sshEndpoint`. */
  endpoint: string
  user: string
  /** `<type> <base64>`, as Boat's `hostKey`. */
  hostKey: string
  authorize(publicKey: string): Promise<void>
  /**
   * Lets `token` log in as the login user with no key or password, as Daytona's SSH gateway takes
   * a token for a user name.
   */
  allowToken(token: string): Promise<void>
  remove(): Promise<void>
}

const SSH_VM_BASE = `FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server sudo curl git procps ca-certificates && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash user \\
 && echo 'user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/user \\
 && mkdir -p /home/user/.ssh /run/sshd \\
 && chown -R user:user /home/user && chmod 750 /home/user && chmod 700 /home/user/.ssh \\
 && echo 'PermitEmptyPasswords yes' > /etc/ssh/sshd_config.d/token.conf \\
 && ssh-keygen -A
`

/**
 * The Node an image has where reeval looks for it: each provider's VMs have their own.
 * `boat-docker` is Boat's with the Docker CLI on the host's daemon, as Boat's VMs have Docker.
 */
export type SshVmLayout = 'boat' | 'daytona' | 'boat-docker'

/**
 * A cloud Linux VM's layout where it matters to reeval: a login user `user` with passwordless
 * sudo, sshd and git, and a Node where its provider has it. Boat's `/usr/local/bin/node` links
 * into that user's nvm, under a home others can't enter. Daytona's is an nvm everyone can read,
 * on the login user's `PATH` but not the system's, which has a Node with no npm beside it. No
 * `reeval` user: the session makes it.
 */
const BOAT_VM = `${SSH_VM_BASE}RUN mkdir -p /home/user/.nvm/versions/node/current/bin \\
 && mv /usr/local/bin/node /home/user/.nvm/versions/node/current/bin/node \\
 && ln -s /home/user/.nvm/versions/node/current/bin/node /usr/local/bin/node \\
 && chown -R user:user /home/user/.nvm
`
/** The Docker CLI and buildx the `boat-docker` layout copies in. */
const DOCKER_CLI_IMAGE = 'docker:29-cli'
const SSH_VM_DOCKERFILES: Record<SshVmLayout, string> = {
  boat: `${BOAT_VM}CMD ["/usr/sbin/sshd", "-D", "-e"]
`,
  'boat-docker': `${BOAT_VM}COPY --from=${DOCKER_CLI_IMAGE} /usr/local/bin/docker /usr/local/bin/docker
COPY --from=${DOCKER_CLI_IMAGE} /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
CMD ["/usr/sbin/sshd", "-D", "-e"]
`,
  daytona: `${SSH_VM_BASE}RUN v=/usr/local/share/nvm/versions/node/v0 && mkdir -p $v/bin $v/lib \\
 && mv /usr/local/lib/node_modules $v/lib/ && cp /usr/local/bin/node $v/bin/node \\
 && ln -s ../lib/node_modules/npm/bin/npm-cli.js $v/bin/npm \\
 && mv /usr/local/bin/node /usr/bin/node && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \\
 && ln -s $v /usr/local/share/nvm/current \\
 && echo 'SetEnv PATH=/usr/local/share/nvm/current/bin:/usr/local/bin:/usr/bin:/bin' > /etc/ssh/sshd_config.d/path.conf
CMD ["/usr/sbin/sshd", "-D", "-e"]
`,
}

const imageOf = (layout: SshVmLayout) =>
  `reeval-fake-ssh-vm:${createHash('sha256').update(SSH_VM_DOCKERFILES[layout]).digest('hex').slice(0, 12)}`
/** Boat's fake VM image's tag, which changes with its Dockerfile. */
export const SSH_VM_IMAGE = imageOf('boat')
/** The label on every fake VM's container, its value the VM's name. */
export const SSH_VM_LABEL = 'reeval.test.fake-ssh-vm'

/** Builds each of `layouts`' fake VM image unless it's there. */
export function buildSshVmImage(layouts: readonly SshVmLayout[] = ['boat', 'daytona']): void {
  for (const layout of layouts) {
    const image = imageOf(layout)
    try {
      execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' })
      continue
    } catch {}
    execFileSync('docker', ['build', '-q', '-t', image, '-'], {
      input: SSH_VM_DOCKERFILES[layout],
      stdio: ['pipe', 'ignore', 'inherit'],
    })
  }
}

const docker = (args: string[], input?: string) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => {
      out += d
    })
    child.stderr.on('data', (d: Buffer) => {
      err += d
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`docker ${args[0]}: ${err.trim()}`)),
    )
    // The child may exit before reading its stdin.
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })

/** Until `port` on 127.0.0.1 greets with an SSH banner. */
async function sshUp(port: number, deadline = Date.now() + 30_000): Promise<void> {
  for (;;) {
    const banner = await new Promise<string>((resolve) => {
      const socket = connect(port, '127.0.0.1')
      socket.setTimeout(2000)
      socket.once('data', (d) => {
        resolve(String(d))
        socket.destroy()
      })
      // Docker's port proxy accepts, then closes, until sshd listens.
      socket.once('close', () => resolve(''))
      socket.once('error', () => resolve(''))
      socket.once('timeout', () => {
        resolve('')
        socket.destroy()
      })
    })
    if (banner.startsWith('SSH-')) return
    if (Date.now() > deadline) throw new Error(`the fake VM's sshd never answered on ${port}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** The CPUs and memory each Daytona-layout fake VM has. */
export const DAYTONA_VM_SIZE = { vcpus: 2, memoryBytes: 2 * 1024 ** 3 }
const DAYTONA_VM_LIMITS = [
  '--cpus',
  String(DAYTONA_VM_SIZE.vcpus),
  '--memory',
  String(DAYTONA_VM_SIZE.memoryBytes),
]

/** A fake VM of `layout`'s image named `name` by its label, its sshd on a port of 127.0.0.1. */
export async function startSshVm(name: string, layout: SshVmLayout = 'boat'): Promise<SshVm> {
  const id = await docker([
    'run',
    '-d',
    '--rm',
    '--label',
    `${SSH_VM_LABEL}=${name}`,
    // A VM's root reads every process's environment, which the marker kill looks in.
    '--cap-add',
    'SYS_PTRACE',
    // And mounts, as a shared machine binds each slot's home where its commands see it.
    '--cap-add',
    'SYS_ADMIN',
    '--security-opt',
    'apparmor=unconfined',
    // A Daytona sandbox is a container with limits of its own, which it reads its sizes from.
    ...(layout === 'daytona' ? DAYTONA_VM_LIMITS : []),
    // Its Docker is the host's: images it builds and containers it makes are the host daemon's.
    ...(layout === 'boat-docker' ? ['-v', `${DOCKER_SOCKET}:/var/run/docker.sock`] : []),
    '-p',
    '127.0.0.1::22',
    imageOf(layout),
  ])
  const remove = async () => {
    await docker(['rm', '-f', id]).catch(() => {})
  }
  try {
    if (layout === 'boat-docker') {
      const gid = statSync(DOCKER_SOCKET).gid
      await docker([
        'exec',
        id,
        'sh',
        '-c',
        `getent group ${gid} >/dev/null || groupadd -g ${gid} docker; usermod -aG "$(getent group ${gid} | cut -d: -f1)" user`,
      ])
    }
    const mapped = await docker(['port', id, '22/tcp'])
    const port = Number(/:(\d+)\s*$/m.exec(mapped)?.[1])
    await sshUp(port)
    const hostKey = (await docker(['exec', id, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub']))
      .split(' ')
      .slice(0, 2)
      .join(' ')
    return {
      endpoint: `127.0.0.1:${port}`,
      user: 'user',
      hostKey,
      authorize: async (publicKey) => {
        await docker(
          [
            'exec',
            '-i',
            '-u',
            'user',
            id,
            'sh',
            '-c',
            'cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys',
          ],
          `${publicKey}\n`,
        )
      },
      // A second name for the login user's uid, with no password: sshd's `none` method lets it in,
      // and sudo, which goes by uid, finds the user's rule.
      allowToken: async (token) => {
        await docker([
          'exec',
          id,
          'sh',
          '-c',
          `useradd -o -u "$(id -u user)" -g user -d /home/user -M -s /bin/bash ${token} && passwd -d ${token} >/dev/null`,
        ])
      },
      remove,
    }
  } catch (error) {
    await remove()
    throw error
  }
}

const DOCKER_SOCKET = '/var/run/docker.sock'

/** A fake Boat VM whose Docker CLI reaches the host's daemon, for builds over its SSH. */
export const startBoatDockerVm = (name: string) => startSshVm(name, 'boat-docker')

/** A fake VM laid out as Daytona's sandboxes are. */
export const startDaytonaVm = (name: string) => startSshVm(name, 'daytona')

/** The container of the fake VM named `name`, or `null` once it's gone. */
export function sshVmContainer(name: string): string | null {
  const id = execFileSync('docker', ['ps', '-q', '--filter', `label=${SSH_VM_LABEL}=${name}`])
    .toString()
    .trim()
  return id || null
}
