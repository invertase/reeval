"""The `reeval` command: runs the reeval binary made for this reeval-python, with its arguments.

It downloads the binary: for version V and target T (`-baseline` on an x64 CPU without AVX2, as
scripts/install.sh picks) it is `reeval-V-T` (`.exe` on Windows) in the GitHub release `vV`. It's
cached at `<cache>/reeval/bin/V/` once it starts, beside a marker of the hash it was checked
against. The released sdist and wheel record each target's sha256 and size in
`reeval_python/binaries.json`, which the download must match; the release's SHA256SUMS must agree
too. Every language SDK's launcher downloads the same way. A platform wheel (built by
scripts/python-wheels.py, not published) carries the binary in `reeval_python/bin/` instead.
"""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import platform
import re
import signal
import stat
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


PRERELEASES = {"a": "alpha", "b": "beta", "rc": "rc"}


def semver(version: str) -> str:
    """reeval's version for a reeval-python version: 1.0.0b1 is 1.0.0-beta.1."""
    if m := re.fullmatch(r"(\d+\.\d+\.\d+)(a|b|rc)(\d+)", version):
        return f"{m[1]}-{PRERELEASES[m[2]]}.{m[3]}"
    return version


def own_version() -> str | None:
    """The reeval this reeval-python was made for, as reeval spells its version."""
    try:
        return semver(dist_version("reeval-python"))
    except PackageNotFoundError:
        return None


def pinned_version() -> str:
    """REEVAL_VERSION as reeval spells its version, so 1.0.0rc1 is 1.0.0-rc.1; empty if unset."""
    return semver(os.environ.get("REEVAL_VERSION", "").strip().removeprefix("v"))


def binary_version() -> str:
    if pinned := pinned_version():
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


def _command(args: list[str]) -> tuple[int, str] | None:
    """The exit code and output (stdout and stderr) of a command, or None if it can't run."""
    try:
        done = subprocess.run(
            args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=10
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return done.returncode, done.stdout


def musl() -> bool:
    """Whether musl is the system's libc, by scripts/install.sh's rule: a glibc system can have
    musl's loader installed too, so getconf, then ldd, decides, and the loader only without them."""
    getconf = _command(["getconf", "GNU_LIBC_VERSION"])
    if getconf is not None and getconf[0] == 0:
        return False
    ldd = _command(["ldd", "--version"])
    said = ldd[1] if ldd else ""
    if "musl" in said:
        return True
    if "GLIBC" in said or "GNU libc" in said:
        return False
    return any(Path("/lib").glob("ld-musl-*"))


def avx2(system: str) -> bool:
    """Whether the CPU has AVX2, which the default x64 builds need; the baseline ones don't."""
    if system == "win32":
        import ctypes

        kernel32: Any = getattr(ctypes, "windll").kernel32  # noqa: B009
        return bool(kernel32.IsProcessorFeaturePresent(40))  # PF_AVX2_INSTRUCTIONS_AVAILABLE
    try:
        cpuinfo = Path("/proc/cpuinfo").read_text()
    except OSError:
        return False
    return re.search(r"\bavx2\b", cpuinfo) is not None


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
    if os_name == "darwin":
        return f"darwin-{arch}"
    # Windows on ARM runs the x64 binary under emulation.
    found = "windows-x64" if os_name == "windows" else f"linux-{arch}"
    if os_name == "linux" and musl():
        found += "-musl"
    if (os_name == "windows" or arch == "x64") and not avx2(system):
        found += "-baseline"
    return found


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
    except (urllib.error.URLError, http.client.HTTPException, OSError) as error:
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
    own = released()
    if want is None and own is not None and own.get("version") == version:
        raise ShimError(
            f"reeval-python {version} was released with no reeval binary for {target}."
            " Set REEVAL_BINARY to a reeval binary.",
            3,
        )
    listed = parse_sums(_fetch(f"{base}/SHA256SUMS").decode()).get(name)
    if want is None:
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
    check_starts(dest, name)
    mark_verified(dest, expected)


def describe_exit(code: int) -> str:
    if code < 0:
        try:
            return f"killed by {signal.Signals(-code).name}"
        except ValueError:
            return f"killed by signal {-code}"
    if code == 0xC000001D:  # STATUS_ILLEGAL_INSTRUCTION
        return "an illegal instruction"
    return f"exit {code}"


def check_starts(binary: Path, name: str) -> None:
    """Runs `binary --version`, and drops it from the cache unless it starts: a CPU without
    an instruction the build needs kills it outright, before reeval can say why."""
    try:
        done = subprocess.run(
            [str(binary), "--version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
            timeout=TIMEOUT,
        )
    except OSError as error:
        why = str(error.strerror or error)
    except subprocess.TimeoutExpired:
        why = f"no answer to --version in {TIMEOUT}s"
    else:
        if done.returncode == 0:
            return
        said = done.stderr.strip().splitlines()
        why = describe_exit(done.returncode) + (f": {said[0]}" if said else "")
    try:
        binary.unlink(missing_ok=True)
    except OSError:
        pass
    raise ShimError(
        f"{name} doesn't start on this machine ({why}), so it wasn't kept."
        " REEVAL_BINARY names a reeval binary to run instead.",
        3,
    )


def _marker(binary: Path) -> Path:
    return binary.with_name(f"{binary.name}.sha256")


def _identity(binary: Path) -> str:
    # ctime too: setting the mtime back after a rewrite moves the ctime on.
    st = binary.stat()
    return f"{st.st_size} {st.st_mtime_ns} {st.st_ctime_ns} {st.st_ino}"


def mark_verified(binary: Path, digest: str) -> None:
    """Records that `binary`, as it is now on disk, has sha256 `digest`."""
    try:
        _marker(binary).write_text(f"{digest} {_identity(binary)}\n")
    except OSError:
        pass


def verified(binary: Path, want: dict[str, Any] | None) -> bool:
    """Whether the cached `binary` can run: it hashes to the recorded sha256, else to the one its
    marker holds (taken as read while the file is unchanged since the marker was written). With
    neither a record nor a marker, it was put there by hand, as for REEVAL_OFFLINE, and runs."""
    try:
        size = binary.stat().st_size
        identity = _identity(binary)
    except OSError:
        return False
    if size == 0 or (want is not None and size != want.get("size", size)):
        return False
    try:
        digest, _, seen = _marker(binary).read_text().strip().partition(" ")
    except OSError:
        digest = seen = ""
    expected = want.get("sha256") if want is not None else digest or None
    if expected is None:
        return True
    if seen == identity and digest == expected:
        return True
    if sha256(binary) == expected:
        mark_verified(binary, expected)
        return True
    return False


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
    pinned = pinned_version()
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
        if verified(cached, want):
            return cached
        cached.unlink(missing_ok=True)
        _marker(cached).unlink(missing_ok=True)
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
        try:
            binary.unlink(missing_ok=True)
            message += " It's been removed from the cache, so the next run downloads it again."
        except OSError:
            pass
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
    except KeyboardInterrupt:
        sys.exit(130)
