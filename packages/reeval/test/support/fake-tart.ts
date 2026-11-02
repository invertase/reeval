// A `tart` on PATH that runs each VM as a directory on this machine, with `sudo` and `ssh` beside
// it, so the Tart sandbox's lifecycle runs on Linux. Every `tart` call is logged, one per line.
//
// FAKE_TART_NO_AGENT=1: `tart exec` fails, as without the Guest Agent. FAKE_TART_NO_SUDO=1:
// `sudo -n` asks for a password. FAKE_TART_RUN_FAILS=1: `tart run` exits at once.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TART = `#!/bin/bash
root="$FAKE_TART_DIR"
echo "$*" >> "$root/log"
cmd=$1; shift
case "$cmd" in
  --version) echo 2.30.0 ;;
  pull) echo "$1" >> "$root/pulled" ;;
  clone) mkdir -p "$root/vms/$2/home" && echo "$1" > "$root/vms/$2/image" ;;
  set) echo "$*" > "$root/vms/$1/set" ;;
  run)
    [ -n "$FAKE_TART_RUN_FAILS" ] && { echo "no space for $1" >&2; exit 1; }
    touch "$root/vms/$1/running"
    while [ -f "$root/vms/$1/running" ]; do sleep 0.1; done ;;
  exec)
    [ "$1" = -i ] && shift
    vm=$1; shift
    [ -n "$FAKE_TART_NO_AGENT" ] && { echo "guest agent not running" >&2; exit 1; }
    [ -f "$root/vms/$vm/running" ] || { echo "$vm is not running" >&2; exit 1; }
    cd "$root/vms/$vm/home" && HOME="$root/vms/$vm/home" exec "$@" ;;
  ip) [ -f "$root/vms/$1/running" ] && echo 127.0.0.1 || exit 1 ;;
  stop) [ "$1" = --timeout ] && shift 2; rm -f "$root/vms/$1/running" ;;
  delete) rm -rf "$root/vms/$1" ;;
  list)
    printf '['; sep=
    for d in "$root"/vms/*/; do [ -d "$d" ] || continue; printf '%s{"Name":"%s"}' "$sep" "$(basename "$d")"; sep=,; done
    [ -f "$root/pulled" ] && while read -r i; do printf '%s{"Name":"%s"}' "$sep" "$i"; sep=,; done < "$root/pulled"
    echo ']' ;;
  *) echo "fake tart: no $cmd" >&2; exit 2 ;;
esac
`

// Root-owned paths land under the fake VM's directory: the gateway installs its CA there.
const SUDO = `#!/bin/bash
[ "$1" = -n ] && shift
[ -n "$FAKE_TART_NO_SUDO" ] && { echo "sudo: a password is required" >&2; exit 1; }
args=()
for a in "$@"; do args+=("\${a//\\/usr\\/local\\/share\\/ca-certificates/$FAKE_TART_DIR/ca}"); done
exec "\${args[@]}"
`

// The last argument is the remote command line; the one running VM is the host.
const SSH = `#!/bin/bash
echo "ssh $*" >> "$FAKE_TART_DIR/log"
for vm in "$FAKE_TART_DIR"/vms/*/; do [ -f "$vm/running" ] && break; done
cd "$vm/home" && HOME="$vm/home" exec /bin/sh -c "\${@: -1}"
`

/** Puts the fake `tart`, `sudo` and `ssh` first on PATH; returns the directory its VMs live in. */
export function installFakeTart(): { dir: string; log: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'reeval-fake-tart-'))
  const bin = join(dir, 'bin')
  mkdirSync(join(dir, 'vms'), { recursive: true })
  mkdirSync(bin)
  for (const [name, script] of Object.entries({ tart: TART, sudo: SUDO, ssh: SSH })) {
    writeFileSync(join(bin, name), script)
    chmodSync(join(bin, name), 0o755)
  }
  writeFileSync(join(dir, 'log'), '')
  process.env.FAKE_TART_DIR = dir
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`
  return {
    dir,
    log: () => readFileSync(join(dir, 'log'), 'utf8').split('\n').filter(Boolean),
  }
}
