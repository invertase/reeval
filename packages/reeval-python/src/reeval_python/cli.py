"""The `reeval` command: runs the reeval binary made for this reeval-python, with its arguments.

A platform wheel carries the binary in `reeval_python/bin/`. The pure wheel downloads it: the
binary for version V and target T is `reeval-V-T` (`.exe` on Windows) in the GitHub release `vV`,
listed in that release's SHA256SUMS, and is cached at `<cache>/reeval/bin/V/`. Every language
SDK's launcher downloads the same way.
"""

from __future__ import annotations

import hashlib
import os
import platform
import subprocess
import sys
import urllib.error
import urllib.request
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as dist_version
from pathlib import Path

REPO = "invertase/reeval"
TIMEOUT = 60


class ShimError(Exception):
    def __init__(self, message: str, code: int) -> None:
        super().__init__(message)
        self.code = code


def binary_version() -> str:
    pinned = os.environ.get("REEVAL_VERSION", "").strip().removeprefix("v")
    if pinned:
        return pinned
    try:
        return dist_version("reeval-python")
    except PackageNotFoundError:
        raise ShimError(
            "reeval-python isn't installed as a package, so it can't tell which reeval to run."
            " Set REEVAL_VERSION, or REEVAL_BINARY to a reeval binary.",
            2,
        ) from None


def target() -> str:
    machine = platform.machine().lower()
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine)
    system = {"linux": "linux", "darwin": "darwin", "win32": "windows"}.get(sys.platform)
    if arch is None or system is None or (system == "windows" and arch != "x64"):
        raise ShimError(
            f"There's no reeval binary for {sys.platform} {platform.machine()}."
            " Set REEVAL_BINARY to one you built, or use the npm package.",
            2,
        )
    if system == "linux" and (
        Path("/etc/alpine-release").exists() or any(Path("/lib").glob("ld-musl-*"))
    ):
        return f"linux-{arch}-musl"
    return f"{system}-{arch}"


def asset(version: str, target: str) -> str:
    return f"reeval-{version}-{target}{'.exe' if target.startswith('windows') else ''}"


def cache_dir() -> Path:
    """reeval's own cache directory, as the binary computes it."""
    if base := os.environ.get("XDG_CACHE_HOME"):
        return Path(base) / "reeval"
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(local) / "reeval"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "reeval"
    return Path.home() / ".cache" / "reeval"


def _fetch(url: str) -> bytes:
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as response:  # noqa: S310
            return response.read()
    except (urllib.error.URLError, OSError) as error:
        raise ShimError(
            f"Couldn't download {url}: {getattr(error, 'reason', error)}. REEVAL_DOWNLOAD names"
            " a mirror, and REEVAL_BINARY a binary to run instead.",
            3,
        ) from None


def download(version: str, name: str, dest: Path) -> None:
    base = os.environ.get("REEVAL_DOWNLOAD") or (
        f"https://github.com/{REPO}/releases/download/v{version}"
    )
    base = base.rstrip("/")
    sums = _fetch(f"{base}/SHA256SUMS").decode()
    listed = (line.split() for line in sums.splitlines())
    expected = next((f[0] for f in listed if f[1:] in ([name], [f"*{name}"])), None)
    if expected is None:
        raise ShimError(f"{base}/SHA256SUMS doesn't list {name}.", 3)
    print(f"reeval: downloading {name}", file=sys.stderr)
    data = _fetch(f"{base}/{name}")
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected:
        raise ShimError(
            f"{base}/{name} doesn't match SHA256SUMS (got {actual}, expected {expected}).", 3
        )
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_name(f"{name}.{os.getpid()}.partial")
    partial.write_bytes(data)
    partial.chmod(0o755)
    os.replace(partial, dest)


def bundled() -> Path:
    """Where a platform wheel puts its binary; the pure wheel has none."""
    return Path(__file__).with_name("bin") / ("reeval.exe" if sys.platform == "win32" else "reeval")


def resolve() -> Path:
    """The reeval binary to run: REEVAL_BINARY, this wheel's own, or the cached one (downloaded)."""
    if override := os.environ.get("REEVAL_BINARY"):
        if not Path(override).is_file():
            raise ShimError(f"REEVAL_BINARY is {override}, which isn't a file.", 2)
        return Path(override)
    if not os.environ.get("REEVAL_VERSION") and bundled().is_file():
        return bundled()
    version = binary_version()
    name = asset(version, target())
    cached = cache_dir() / "bin" / version / name
    if cached.is_file():
        return cached
    if os.environ.get("REEVAL_OFFLINE", "") not in ("", "0", "false"):
        raise ShimError(
            f"reeval {version} isn't in the cache and REEVAL_OFFLINE is set."
            f" Put {name} at {cached}, or set REEVAL_BINARY.",
            2,
        )
    download(version, name, cached)
    return cached


def main(argv: list[str] | None = None) -> None:
    args = sys.argv[1:] if argv is None else argv
    try:
        binary = resolve()
    except ShimError as error:
        print(f"reeval: {error}", file=sys.stderr)
        sys.exit(error.code)
    # The evals run on this interpreter, which has this reeval-python.
    env = {"REEVAL_PYTHON": sys.executable, **os.environ}
    if sys.platform == "win32":
        try:
            sys.exit(subprocess.run([str(binary), *args], env=env).returncode)
        except KeyboardInterrupt:
            sys.exit(130)
    os.execve(binary, [str(binary), *args], env)
