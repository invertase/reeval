// A `tart` on PATH that runs each VM as a directory on this machine, with `sudo`, `security`,
// `ssh` and `lsof` beside it, so the Tart sandbox's lifecycle runs on Linux. Every `tart` call is logged,
// one per line. As in a VM, a `tart exec` command runs apart from the host's `tart`: a child of
// it in a process group of its own, led by a shell above it, so killing `tart exec`, or its process
// group, leaves the command running.
//
// FAKE_TART_NO_AGENT=1: `tart exec` fails, as without the Guest Agent, after blocking for
// FAKE_TART_EXEC_BLOCKS seconds as tart 2.41 does (about 30). FAKE_TART_NO_SUDO=1: `sudo -n` asks
// for a password. FAKE_TART_NO_TRUST=1: `security add-trusted-cert` is denied, as without a
// trust-settings authorization rule. FAKE_TART_RUN_FAILS: `tart run` exits at once, saying it
// (`1`: out of disk). FAKE_TART_PULL_FAILS: `tart pull` fails, saying it.
// FAKE_TART_CLONE_FAILS: `tart clone` fails, saying it, after starting the VM's directory.
//
// {@link fakeTartHosts} adds Macs that `ssh <host>` reaches: each a directory of its own under
// `hosts/`, with its own VMs, images and log, and its free space, memory and system in files there.
// `tart run` there refuses a VM beyond its `limit`, as macOS does at its VM limit. As with sshd,
// killing `ssh` leaves the command it ran on a Mac running.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
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
  clone)
    [ -n "$FAKE_TART_CLONE_FAILS" ] && { mkdir -p "$root/vms/$2"; echo "$FAKE_TART_CLONE_FAILS" >&2; exit 1; }
    [ -f "$root/clone-fails" ] && { cat "$root/clone-fails" >&2; exit 1; }
    [ -f "$root/clone-seconds" ] && sleep "$(cat "$root/clone-seconds")"
    mkdir -p "$root/vms/$2/home" && echo "$1" > "$root/vms/$2/image"
    # A local VM's clone has its disk: here, its home and disk.img.
    if [ -d "$root/vms/$1/home" ]; then
      cp -a "$root/vms/$1/home/." "$root/vms/$2/home/" && cp -p "$root/vms/$1/disk.img" "$root/vms/$2/disk.img"
    else echo "$1" > "$root/vms/$2/disk.img"; fi ;;
  rename)
    [ -d "$root/vms/$1" ] && [ ! -e "$root/vms/$2" ] || { echo "can't rename $1 to $2" >&2; exit 1; }
    mv "$root/vms/$1" "$root/vms/$2" ;;
  set) echo "$*" > "$root/vms/$1/set" ;;
  run)
    if [ -f "$root/limit" ]; then
      n=$(ls "$root"/vms/*/running 2>/dev/null | wc -l)
      # Late: tart exits before what it said reaches the other end, as over ssh it can.
      [ "$n" -ge "$(cat "$root/limit")" ] && [ -f "$root/refuses-late" ] && { ( sleep 0.3; echo "The number of VMs exceeds the system limit" >&2 ) & exit 1; }
      [ "$n" -ge "$(cat "$root/limit")" ] && { echo "The number of VMs exceeds the system limit" >&2; exit 1; }
    fi
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
    HOME="$root/vms/$vm/home" exec perl -e 'my $p = fork // die; if (!$p) { setpgrp(0, 0); exec @ARGV } waitpid($p, 0); exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' /bin/sh -c '"$@"; exit $?' sh "$@" ;;
  ip) [ -f "$root/vms/$1/running" ] && echo 127.0.0.1 || exit 1 ;;
  get) [ -d "$root/vms/$1" ] || exit 1; printf '{"OS":"%s"}\n' "$(cat "$root/vms/$1/os" 2>/dev/null || echo darwin)" ;;
  stop) [ "$1" = --timeout ] && shift 2; rm -f "$root/vms/$1/running" ;;
  delete) rm -rf "$root/vms/$1" ;;
  list)
    printf '['; sep=
    for d in "$root"/vms/*/; do
      [ -d "$d" ] || continue; state=stopped; [ -f "$d/running" ] && state=running
      printf '%s{"Name":"%s","State":"%s"}' "$sep" "$(basename "$d")" "$state"; sep=,
    done
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
  a="\${a/#\\/usr\\/bin\\/security/$FAKE_TART_DIR/bin/security}"
  args+=("\${a//\\/tmp\\/reeval-egress-forwarder/$vmtmp/reeval-egress-forwarder}")
done
exec "\${args[@]}"
`

const SECURITY = `#!/bin/sh
[ -n "$FAKE_TART_NO_TRUST" ] && { echo "SecTrustSettingsSetTrustSettings: The authorization was denied since no user interaction was possible." >&2; exit 1; }
exit 0
`

// The destination is the first argument that isn't an option; the rest is the remote command
// line. A destination under hosts/ is a Mac of fakeTartHosts, which runs it with that Mac's
// tart; any other name is unknown once there are hosts. Else the one running VM is the host.
const SSH = `#!/bin/bash
echo "ssh $*" >> "$FAKE_TART_DIR/log"
while [ $# -gt 0 ]; do
  case $1 in
    --) shift; break ;;
    -[oplibcFJLRDEmSw]) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
dest=$1; shift
host=\${dest##*@}
mac="$FAKE_TART_DIR/hosts/$host"
if [ -d "$mac" ] && [ ! -f "$mac/unreachable" ]; then
  echo "$*" >> "$mac/ssh.log"
  # As sshd runs it: in a process group of its own, so killing this ssh leaves it running.
  exec 3<&0
  FAKE_TART_DIR="$mac" TART_HOME="$mac" PATH="$FAKE_TART_HOSTBIN:$PATH" \\
    perl -e 'setpgrp(0, 0); exec @ARGV' /bin/sh -c "$*" <&3 > >(cat) 2> >(cat >&2) &
  wait $!; exit $?
fi
if [ -d "$FAKE_TART_DIR/hosts" ] && [ "$host" != 127.0.0.1 ]; then
  echo "ssh: Could not resolve hostname $host: nodename nor servname provided, or not known" >&2
  exit 255
fi
for vm in "$FAKE_TART_DIR"/vms/*/; do [ -f "$vm/running" ] && break; done
cd "$vm/home" && HOME="$vm/home" exec /bin/sh -c "\${@: -1}"
`

// A Mac's own df, sysctl and uname, from its files: free kilobytes, memory and system.
const HOST_DF = `#!/bin/bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
printf '/dev/disk3s5 999999999 1 %s 1%% /\\n' "$(cat "$FAKE_TART_DIR/free-kb" 2>/dev/null || echo 900000000)"
`
const HOST_SYSCTL = `#!/bin/bash
cat "$FAKE_TART_DIR/memsize" 2>/dev/null || echo 68719476736
`
const HOST_UNAME = `#!/bin/bash
system=$(cat "$FAKE_TART_DIR/system" 2>/dev/null || echo Darwin-arm64)
case $1 in -s) echo "\${system%-*}" ;; -m) echo "\${system#*-}" ;; *) echo "\${system%-*}" ;; esac
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
  for (const [name, script] of Object.entries({
    tart: TART,
    sudo: SUDO,
    security: SECURITY,
    ssh: SSH,
    lsof: LSOF,
  })) {
    writeFileSync(join(bin, name), script)
    chmodSync(join(bin, name), 0o755)
  }
  const hostbin = join(dir, 'hostbin')
  mkdirSync(hostbin)
  for (const [name, script] of Object.entries({
    df: HOST_DF,
    sysctl: HOST_SYSCTL,
    uname: HOST_UNAME,
  })) {
    writeFileSync(join(hostbin, name), script)
    chmodSync(join(hostbin, name), 0o755)
  }
  const env = {
    FAKE_TART_DIR: dir,
    FAKE_TART_HOSTBIN: hostbin,
    TART_HOME: dir,
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

/** How long {@link holdLoopback} waits for the loopback before it fails. */
export const LOOPBACK_WAIT_MS = 120_000

/** A Mac of {@link fakeTartHosts}: the images it has, and what its checks and `tart run` find. */
export type FakeTartHost = {
  images?: string[]
  /** Kilobytes free on Tart's volume; 900 GB when unset. */
  freeKb?: number
  /** `hw.memsize`; 64 GiB when unset. */
  memsize?: number
  /** `uname -s`-`uname -m`; `Darwin-arm64` when unset. */
  system?: string
  /** How many VMs `tart run` lets run at once; unlimited when unset. */
  limit?: number
  /** `ssh` can't reach it. */
  unreachable?: boolean
  /** Seconds `tart clone` takes. */
  cloneSeconds?: number
  /** What `tart clone` fails saying. */
  cloneFails?: string
  /** `tart run` at its `limit` exits before its refusal reaches stderr's other end. */
  refusesLate?: boolean
}

/**
 * A {@link fakeTart} that also has the Macs in `hosts`, by name, each with its own state under
 * `hosts/<name>`; `log(name)` is that Mac's `tart` log, and `vms(name)` the VMs it has.
 */
export function fakeTartHosts(
  hosts: Record<string, FakeTartHost>,
  images: string[] = [],
): ReturnType<typeof fakeTart> & {
  hostLog: (name: string) => string[]
  vms: (name: string) => string[]
} {
  const fake = fakeTart(images)
  for (const [name, h] of Object.entries(hosts)) {
    const mac = join(fake.dir, 'hosts', name)
    mkdirSync(join(mac, 'vms'), { recursive: true })
    const files = {
      'free-kb': h.freeKb,
      memsize: h.memsize,
      system: h.system,
      limit: h.limit,
      unreachable: h.unreachable ? '' : undefined,
      'clone-seconds': h.cloneSeconds,
      'clone-fails': h.cloneFails,
      'refuses-late': h.refusesLate ? '' : undefined,
    }
    for (const [file, value] of Object.entries(files)) {
      if (value !== undefined) writeFileSync(join(mac, file), String(value))
    }
    for (const image of h.images ?? []) {
      spawnSync(join(fake.dir, 'bin', 'tart'), ['pull', image], {
        env: { ...process.env, ...fake.env, FAKE_TART_DIR: mac, TART_HOME: mac },
      })
    }
    writeFileSync(join(mac, 'log'), '')
  }
  const read = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean)
  return {
    ...fake,
    hostLog: (name) => read(join(fake.dir, 'hosts', name, 'log')),
    vms: (name) => readdirSync(join(fake.dir, 'hosts', name, 'vms')),
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
  const deadline = Date.now() + LOOPBACK_WAIT_MS
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
      throw new Error(
        `another process held 127.0.0.1:${LOOPBACK_LOCK_PORT} for ${LOOPBACK_WAIT_MS / 1000}s`,
      )
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
