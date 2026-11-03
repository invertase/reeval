// A `tart` on PATH that runs each VM as a directory on this machine, with `sudo`, `ssh` and
// `lsof` beside it, so the Tart sandbox's lifecycle runs on Linux. Every `tart` call is logged,
// one per line. As in a VM, a `tart exec` command runs apart from the host's `tart`: in a process
// group of its own, led by a shell above it, so killing `tart exec` leaves it running.
//
// FAKE_TART_NO_AGENT=1: `tart exec` fails, as without the Guest Agent, after blocking for
// FAKE_TART_EXEC_BLOCKS seconds as tart 2.41 does (about 30). FAKE_TART_NO_SUDO=1: `sudo -n` asks
// for a password. FAKE_TART_RUN_FAILS: `tart run` exits at once, saying it (`1`: out of disk).
// FAKE_TART_PULL_FAILS: `tart pull` fails, saying it.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TART = `#!/bin/bash
root="$FAKE_TART_DIR"
echo "$*" >> "$root/log"
# As Tart caches an OCI image: a sha256: directory, and its tag a link to it by absolute path.
# As Tart lists one pulled with no tag: by its :latest name.
pulled() {
  case $1 in */*) ;; *) echo "$1" >> "$root/pulled"; return ;; esac
  repo=\${1%:*}; tag=\${1##*:}; name=$1
  [ "$repo" = "$1" ] || [ "\${tag#*/}" != "$tag" ] && { repo=$1; tag=latest; name=$1:latest; }
  echo "$name" >> "$root/pulled"
  sum=$(printf %s "$1" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-64)
  dir="$TART_HOME/cache/OCIs/$repo"
  mkdir -p "$dir/sha256:$sum" && ln -sfn "$dir/sha256:$sum" "$dir/$tag"
}
cmd=$1; shift
case "$cmd" in
  --version) echo 2.30.0 ;;
  pull)
    [ -n "$FAKE_TART_PULL_FAILS" ] && { echo "$FAKE_TART_PULL_FAILS" >&2; exit 1; }
    echo "pulling manifest..."
    echo "pulling disk (1.2 GB compressed)..."
    for p in 0 3 9 10 25 50 75 99 100; do echo "$p%"; done
    pulled "$1" ;;
  clone) mkdir -p "$root/vms/$2/home" && echo "$1" > "$root/vms/$2/image" ;;
  set) echo "$*" > "$root/vms/$1/set" ;;
  run)
    if [ "$FAKE_TART_RUN_FAILS" = 1 ]; then echo "no space for $1" >&2; exit 1; fi
    [ -n "$FAKE_TART_RUN_FAILS" ] && { echo "$FAKE_TART_RUN_FAILS" >&2; exit 1; }
    touch "$root/vms/$1/running"
    while [ -f "$root/vms/$1/running" ]; do sleep 0.1; done ;;
  exec)
    [ "$1" = -i ] && shift
    vm=$1; shift
    [ -n "$FAKE_TART_NO_AGENT" ] && { sleep "\${FAKE_TART_EXEC_BLOCKS:-0}"; echo "is the Tart Guest Agent running?" >&2; exit 1; }
    [ -f "$root/vms/$vm/running" ] || { echo "$vm is not running" >&2; exit 1; }
    cd "$root/vms/$vm/home" || exit 1
    HOME="$root/vms/$vm/home" exec perl -e 'setpgrp(0, 0); exec @ARGV' /bin/sh -c '"$@"; exit $?' sh "$@" ;;
  ip) [ -f "$root/vms/$1/running" ] && echo 127.0.0.1 || exit 1 ;;
  stop) [ "$1" = --timeout ] && shift 2; rm -f "$root/vms/$1/running" ;;
  delete) rm -rf "$root/vms/$1" ;;
  list)
    printf '['; sep=
    for d in "$root"/vms/*/; do [ -d "$d" ] || continue; printf '%s{"Name":"%s"}' "$sep" "$(basename "$d")"; sep=,; done
    [ -f "$root/pulled" ] && while read -r i; do case $i in */*) src=OCI ;; *) src=local ;; esac; printf '%s{"Name":"%s","Source":"%s"}' "$sep" "$i" "$src"; sep=,; done < "$root/pulled"
    echo ']' ;;
  *) echo "fake tart: no $cmd" >&2; exit 2 ;;
esac
`

// Root-owned paths land under the fake VM's directory: the gateway installs its CA there, and
// each VM keeps its forwarder's pid file in its own /tmp, as a real VM does. `tart exec` and the
// SSH shim run in the VM's home. The VMs still share this machine's loopback, so while one VM's
// gateway holds the forwarder's port, another VM's can't start.
const SUDO = `#!/bin/bash
[ "$1" = -n ] && shift
[ -n "$FAKE_TART_NO_SUDO" ] && { echo "sudo: a password is required" >&2; exit 1; }
vmtmp="\${PWD%/home}/tmp"
mkdir -p "$vmtmp"
args=()
for a in "$@"; do
  a="\${a//\\/usr\\/local\\/share\\/ca-certificates/$FAKE_TART_DIR/ca}"
  args+=("\${a//\\/tmp\\/reeval-egress-forwarder/$vmtmp/reeval-egress-forwarder}")
done
exec "\${args[@]}"
`

// The last argument is the remote command line; the one running VM is the host.
const SSH = `#!/bin/bash
echo "ssh $*" >> "$FAKE_TART_DIR/log"
for vm in "$FAKE_TART_DIR"/vms/*/; do [ -f "$vm/running" ] && break; done
cd "$vm/home" && HOME="$vm/home" exec /bin/sh -c "\${@: -1}"
`

// A VM lists only its own listeners: the real lsof's, of processes working under the VM's
// directory, as the command that asks does. lsof reports that directory with its symlinks
// resolved (macOS's /var is /private/var).
const LSOF = `#!/bin/bash
vm=$(cd "$(printf %s "$PWD" | sed -E 's#(/vms/[^/]+).*#\\1#')" && pwd -P)
real=; for d in /usr/sbin /usr/bin /sbin /bin; do [ -x "$d/lsof" ] && { real=$d/lsof; break; }; done
[ -n "$real" ] || { echo "fake tart: no lsof on this machine" >&2; exit 1; }
keep=
"$real" "$@" | while IFS= read -r l; do
  case $l in
    p*) cwd=$("$real" -a -p "\${l#p}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
      case $cwd in "$vm"/*) keep=1; echo "$l" ;; *) keep= ;; esac ;;
    *) [ -n "$keep" ] && echo "$l" ;;
  esac
done
`

/** The digest the fake `tart pull` gives `image`: the sha256 of its name. */
export const fakeDigest = (image: string) =>
  `sha256:${createHash('sha256').update(image).digest('hex')}`

/**
 * A fake `tart` in a directory of its own, with `images` pulled already: the variables that put
 * it first on PATH (and its home in TART_HOME), and its log, which leaves those pulls out.
 */
export function fakeTart(images: string[] = []): {
  dir: string
  env: NodeJS.ProcessEnv
  log: () => string[]
} {
  const dir = mkdtempSync(join(tmpdir(), 'reeval-fake-tart-'))
  const bin = join(dir, 'bin')
  mkdirSync(join(dir, 'vms'), { recursive: true })
  mkdirSync(bin)
  for (const [name, script] of Object.entries({ tart: TART, sudo: SUDO, ssh: SSH, lsof: LSOF })) {
    writeFileSync(join(bin, name), script)
    chmodSync(join(bin, name), 0o755)
  }
  const env = {
    FAKE_TART_DIR: dir,
    TART_HOME: join(dir, 'home'),
    PATH: `${bin}:${process.env.PATH ?? ''}`,
  }
  for (const image of images) {
    spawnSync(join(bin, 'tart'), ['pull', image], { env: { ...process.env, ...env } })
  }
  writeFileSync(join(dir, 'log'), '')
  return {
    dir,
    env,
    log: () => readFileSync(join(dir, 'log'), 'utf8').split('\n').filter(Boolean),
  }
}

/** The loopback port whose listener is {@link holdLoopback}'s lock. */
const LOOPBACK_LOCK_PORT = 43127

/**
 * Holds this machine's loopback for one process's fake VMs until the returned release. Every
 * fake VM's gateway forwarder binds the same port on it, so a fake VM in another test process
 * would leave this one's VMs without a gateway. The lock is a listener on its own port: taking
 * it is atomic, and the kernel frees it when its holder dies. Waits up to 120s, under a CI
 * file's 300s timeout.
 */
export async function holdLoopback(): Promise<() => void> {
  const deadline = Date.now() + 120_000
  for (;;) {
    const server = createServer()
    const error = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
      server.once('error', resolve)
      server.listen(LOOPBACK_LOCK_PORT, '127.0.0.1', () => resolve(undefined))
    })
    if (!error) {
      server.unref()
      return () => {
        server.close()
      }
    }
    if (error.code !== 'EADDRINUSE') throw error
    if (Date.now() > deadline) {
      throw new Error(`another process held 127.0.0.1:${LOOPBACK_LOCK_PORT} for 120s`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Puts a {@link fakeTart} first on this process's PATH. */
export function installFakeTart(images: string[] = []): { dir: string; log: () => string[] } {
  const fake = fakeTart(images)
  Object.assign(process.env, fake.env)
  return fake
}
