"""The `reeval` command: runs the reeval binary made for this reeval-python, with its arguments.

A platform wheel carries the binary in `reeval_python/bin/`. The pure wheel downloads it: the
binary for version V and target T is `reeval-V-T` (`.exe` on Windows) in the GitHub release `vV`,
and is cached at `<cache>/reeval/bin/V/`. A released wheel records each target's sha256 and size
in `reeval_python/binaries.json`, which the download must match; the release's SHA256SUMS must
agree too. Every language SDK's launcher downloads the same way.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as dist_version
from pathlib import Path
from typing import Any

REPO = "invertase/reeval"
TIMEOUT = 60
WINDOWS = sys.platform == "win32"


class ShimError(Exception):
    def __init__(self, message: str, code: int) -> None:
        super().__init__(message)
        self.code = code


def own_version() -> str | None:
    try:
        return dist_version("reeval-python")
    except PackageNotFoundError:
        return None


def binary_version() -> str:
    pinned = os.environ.get("REEVAL_VERSION", "").strip().removeprefix("v")
    if pinned:
        return pinned
    if own := own_version():
        return own
    raise ShimError(
        "reeval-python isn't installed as a package, so it can't tell which reeval to run."
        " Set REEVAL_VERSION, or REEVAL_BINARY to a reeval binary.",
        2,
    )


def released() -> dict[str, Any] | None:
    """The binaries this reeval-python was released with: version, and each target's hash."""
    path = Path(__file__).with_name("binaries.json")
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def recorded(version: str, target: str) -> dict[str, Any] | None:
    """The sha256 and size this wheel recorded for `version` on `target`, if it's that version."""
    own = released()
    if own is None or own.get("version") != version:
        return None
    return own.get("binaries", {}).get(target)


def elf_interpreter(path: str) -> str | None:
    """The PT_INTERP of an ELF file (its dynamic loader), or None if it has none or isn't ELF."""
    try:
        with open(path, "rb") as f:
            ident = f.read(16)
            if ident[:4] != b"\x7fELF" or ident[4] not in (1, 2) or ident[5] not in (1, 2):
                return None
            wide, end = ident[4] == 2, "<" if ident[5] == 1 else ">"
            header = struct.Struct(end + ("HHIQQQIHHH" if wide else "HHIIIIIHHH"))
            fields = header.unpack(f.read(header.size))
            phoff, phentsize, phnum = fields[4], fields[8], fields[9]
            entry = struct.Struct(end + ("IIQQQQ" if wide else "IIIII"))
            for i in range(phnum):
                f.seek(phoff + i * phentsize)
                ph = entry.unpack(f.read(entry.size))
                if ph[0] == 3:  # PT_INTERP
                    offset, size = (ph[2], ph[5]) if wide else (ph[1], ph[4])
                    f.seek(offset)
                    return f.read(size).rstrip(b"\0").decode(errors="replace")
    except (OSError, struct.error):
        return None
    return None


def libc() -> str | None:
    """The running interpreter's libc, `glibc` or `musl`, as pip's own tag choice decides it."""
    try:
        if os.confstr("CS_GNU_LIBC_VERSION"):
            return "glibc"
    except (AttributeError, OSError, ValueError):
        pass
    loader = elf_interpreter(sys.executable)
    if loader is None:
        return None
    return "musl" if "musl" in loader else "glibc"


def target(system: str = sys.platform, machine: str | None = None) -> str:
    machine = (machine if machine is not None else platform.machine()).lower()
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine)
    os_name = {"linux": "linux", "darwin": "darwin", "win32": "windows"}.get(system)
    if arch is None or os_name is None:
        raise ShimError(
            f"There's no reeval binary for {system} {machine}."
            " Set REEVAL_BINARY to one you built, or use the npm package.",
            2,
        )
    if os_name == "windows":
        # Windows on ARM runs the x64 binary under emulation.
        return "windows-x64"
    if os_name == "linux":
        found = libc()
        musl = found == "musl" if found else Path("/etc/alpine-release").exists()
        if musl:
            return f"linux-{arch}-musl"
    return f"{os_name}-{arch}"


def asset(version: str, target: str) -> str:
    return f"reeval-{version}-{target}{'.exe' if target.startswith('windows') else ''}"


def cache_dir() -> Path:
    """reeval's own cache directory, as the binary computes it."""
    if base := os.environ.get("XDG_CACHE_HOME"):
        return Path(base) / "reeval"
    if WINDOWS:
        local = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(local) / "reeval"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "reeval"
    return Path.home() / ".cache" / "reeval"


class _NoDowngrade(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        if req.full_url.startswith("https:") and not newurl.startswith("https:"):
            raise urllib.error.URLError(f"it redirects to {newurl}, which isn't https")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _fetch(url: str) -> bytes:
    opener = urllib.request.build_opener(_NoDowngrade)
    try:
        with opener.open(url, timeout=TIMEOUT) as response:
            return response.read()
    except (urllib.error.URLError, OSError) as error:
        raise ShimError(
            f"Couldn't download {url}: {getattr(error, 'reason', error)}. REEVAL_DOWNLOAD names"
            " a mirror, and REEVAL_BINARY a binary to run instead.",
            3,
        ) from None


def parse_sums(text: str) -> dict[str, str]:
    """SHA256SUMS as `sha256sum` writes it: `<hex>  <name>`, or `<hex> *<name>` in binary mode."""
    sums: dict[str, str] = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2:
            sums[parts[1].removeprefix("*")] = parts[0].lower()
    return sums


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(2**20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def store(data: bytes, dest: Path, digest: str) -> None:
    """Writes `data` to `dest` whole or not at all, so a crash or a full disk leaves no binary."""
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        fd, partial = tempfile.mkstemp(dir=dest.parent, prefix=f"{dest.name}.", suffix=".partial")
    except OSError as error:
        raise _write_error(dest, error) from None
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(partial, 0o755)
        try:
            os.replace(partial, dest)
        except OSError:
            # Windows can't replace a binary another first run has already started.
            if not (dest.is_file() and sha256(dest) == digest):
                raise
    except OSError as error:
        raise _write_error(dest, error) from None
    finally:
        if os.path.exists(partial):
            os.unlink(partial)


def _write_error(dest: Path, error: OSError) -> ShimError:
    return ShimError(
        f"Couldn't write {dest}: {error.strerror or error}. Free some space or set XDG_CACHE_HOME"
        " to a writable directory, or set REEVAL_BINARY to a reeval binary.",
        3,
    )


def download(version: str, target: str, dest: Path) -> None:
    name = asset(version, target)
    base = (
        os.environ.get("REEVAL_DOWNLOAD")
        or f"https://github.com/{REPO}/releases/download/v{version}"
    ).rstrip("/")
    if base.startswith("http:"):
        print(f"reeval: warning: REEVAL_DOWNLOAD is {base}, which isn't https", file=sys.stderr)
    want = recorded(version, target)
    listed = parse_sums(_fetch(f"{base}/SHA256SUMS").decode()).get(name)
    if want is None:
        own = released()
        why = (
            "records no binary hashes"
            if own is None
            else f"was released with reeval {own.get('version')}, not {version}"
        )
        print(
            f"reeval: this reeval-python {why}, so {name} is checked against"
            f" {base}/SHA256SUMS only",
            file=sys.stderr,
        )
        if listed is None:
            raise ShimError(f"{base}/SHA256SUMS doesn't list {name}.", 3)
        expected = listed
    else:
        expected = want["sha256"]
        if listed is not None and listed != expected:
            raise ShimError(
                f"{base}/SHA256SUMS lists {name} as {listed}, but reeval-python {version} was"
                f" released with {expected}. The release has changed; don't run it.",
                3,
            )
    print(f"reeval: downloading {name}", file=sys.stderr)
    data = _fetch(f"{base}/{name}")
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected:
        source = "SHA256SUMS" if want is None else f"the sha256 reeval-python {version} records"
        raise ShimError(
            f"{base}/{name} doesn't match {source} (got {actual}, expected {expected}).", 3
        )
    store(data, dest, expected)


def bundled() -> Path:
    """Where a platform wheel puts its binary; the pure wheel has none."""
    return Path(__file__).with_name("bin") / ("reeval.exe" if WINDOWS else "reeval")


def launchers() -> list[Path]:
    """This command's own paths: running one of them as reeval would start this again."""
    script = "reeval.exe" if WINDOWS else "reeval"
    return [Path(sys.argv[0]), Path(sys.executable).parent / script]


def _is_launcher(path: Path) -> bool:
    try:
        with open(path, "rb") as f:
            first = f.readline(256)
    except OSError:
        return False
    if first.startswith(b"#!") and b"python" in first:
        return True
    for own in launchers():
        try:
            if own.is_file() and os.path.samefile(own, path):
                return True
        except OSError:
            pass
    return False


def resolve() -> Path:
    """The reeval binary to run: REEVAL_BINARY, this wheel's own, or the cached one (downloaded)."""
    if override := os.environ.get("REEVAL_BINARY"):
        path = Path(override)
        if not path.is_file():
            raise ShimError(f"REEVAL_BINARY is {override}, which isn't a file.", 2)
        if _is_launcher(path):
            raise ShimError(
                f"REEVAL_BINARY is {override}, which is this `reeval` command, not the binary.", 2
            )
        return path
    pinned = os.environ.get("REEVAL_VERSION", "").strip().removeprefix("v")
    own = bundled()
    if own.is_file() and pinned in ("", own_version()):
        if not WINDOWS and not os.access(own, os.X_OK):
            # pip before 25 and some installers drop the exec bit.
            try:
                own.chmod(own.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
            except OSError as error:
                raise ShimError(
                    f"{own} isn't executable and couldn't be made so: {error.strerror}."
                    " Run `chmod +x` on it, or set REEVAL_BINARY.",
                    3,
                ) from None
        return own
    version = binary_version()
    where = target()
    name = asset(version, where)
    cached = cache_dir() / "bin" / version / name
    want = recorded(version, where)
    if cached.is_file():
        size = cached.stat().st_size
        if size and (want is None or size == want.get("size", size)):
            return cached
        cached.unlink(missing_ok=True)
    if os.environ.get("REEVAL_OFFLINE", "") not in ("", "0", "false"):
        raise ShimError(
            f"reeval {version} isn't in the cache and REEVAL_OFFLINE is set."
            f" Put {name} at {cached}, or set REEVAL_BINARY.",
            2,
        )
    download(version, where, cached)
    return cached


def project_python() -> str:
    """The project's interpreter, for the evals: the active venv, else the nearest .venv."""
    exe = Path("Scripts", "python.exe") if WINDOWS else Path("bin", "python")
    if active := os.environ.get("VIRTUAL_ENV"):
        if (Path(active) / exe).is_file():
            return str(Path(active) / exe)
    here = Path.cwd()
    for directory in (here, *here.parents):
        if (directory / ".venv" / exe).is_file():
            return str(directory / ".venv" / exe)
    return sys.executable


def spawn(command: list[str], env: dict[str, str]) -> int:
    """Runs reeval as a child and returns its exit code; Ctrl-C reaches it from the console."""
    # Ignored here, so reeval gets the whole Ctrl-C to stop its attempts and save the run.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    if sys.platform == "win32":
        signal.signal(signal.SIGBREAK, signal.SIG_IGN)
    return subprocess.run(command, env=env).returncode


def _run_error(binary: Path, error: OSError) -> ShimError:
    message = f"Couldn't run {binary}: {error.strerror or error}."
    if binary.is_relative_to(cache_dir()):
        binary.unlink(missing_ok=True)
        message += " It's been removed from the cache, so the next run downloads it again."
    return ShimError(f"{message} REEVAL_BINARY names a reeval binary to run instead.", 3)


def main(argv: list[str] | None = None) -> None:
    args = sys.argv[1:] if argv is None else argv
    try:
        binary = resolve()
        env = dict(os.environ)
        env.setdefault("REEVAL_PYTHON", project_python())
        command = [str(binary), *args]
        if WINDOWS:
            try:
                sys.exit(spawn(command, env))
            except OSError as error:
                raise _run_error(binary, error) from None
        try:
            os.execve(binary, command, env)
        except OSError as error:
            raise _run_error(binary, error) from None
    except ShimError as error:
        print(f"reeval: {error}", file=sys.stderr)
        sys.exit(error.code)
