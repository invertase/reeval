"""Builds reeval-python's platform wheels: the pure wheel plus each target's reeval binary.

    uv run --no-project python scripts/python-wheels.py <pure .whl> <release dir> <out dir>
    python3 scripts/python-wheels.py check <dist dir> <reeval version>

<release dir> holds the binaries and SHA256SUMS as binary.yml builds them, and must have
`reeval-<the wheel's version, as reeval spells it>-<target>` for every target: reeval-python
1.0.0b1 is reeval 1.0.0-beta.1. Each platform wheel is the pure wheel
with `reeval_python/bin/reeval` (`reeval.exe` on Windows) added and its tag changed; the `reeval`
console script runs that binary. The pure wheel stays the fallback for any other platform, where
the console script downloads the binary instead. Every wheel, the pure one rewritten in place,
gets `reeval_python/binaries.json`: each target's sha256 and size, which a download must match.

`check` is release.yml's gate before PyPI: <dist dir> must hold exactly the sdist, the pure wheel
and every platform wheel of reeval <version>, each wheel recording that version's binaries.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import stat
import sys
import tempfile
import zipfile
from pathlib import Path

# The oldest platform each binary runs on: glibc 2.17 (objdump -T), musl 1.2, macOS 13 (Bun).
TAGS = {
    "linux-x64": "manylinux_2_17_x86_64.manylinux2014_x86_64",
    "linux-arm64": "manylinux_2_17_aarch64.manylinux2014_aarch64",
    "linux-x64-musl": "musllinux_1_2_x86_64",
    "linux-arm64-musl": "musllinux_1_2_aarch64",
    "darwin-x64": "macosx_13_0_x86_64",
    "darwin-arm64": "macosx_13_0_arm64",
    "windows-x64": "win_amd64",
}
MANIFEST = "reeval_python/binaries.json"
PRERELEASES = {"alpha": "a", "beta": "b", "rc": "rc"}


def pep440(version: str) -> str:
    """reeval-python's version for reeval's: 1.0.0-beta.1 is 1.0.0b1."""
    if m := re.fullmatch(r"(\d+\.\d+\.\d+)-(alpha|beta|rc)\.(\d+)", version):
        return f"{m[1]}{PRERELEASES[m[2]]}{m[3]}"
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        sys.exit(
            f"python-wheels: reeval {version} has no reeval-python version"
            " (a prerelease must be -alpha.N, -beta.N or -rc.N)"
        )
    return version


def semver(version: str) -> str:
    """reeval's version for reeval-python's: 1.0.0b1 is 1.0.0-beta.1."""
    if m := re.fullmatch(r"(\d+\.\d+\.\d+)(a|b|rc)(\d+)", version):
        name = next(k for k, v in PRERELEASES.items() if v == m[2])
        return f"{m[1]}-{name}.{m[3]}"
    return version


def asset(version: str, target: str) -> str:
    return f"reeval-{version}-{target}{'.exe' if target.startswith('windows') else ''}"


def parse_sums(text: str) -> dict[str, str]:
    sums = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2:
            sums[parts[1].removeprefix("*")] = parts[0].lower()
    return sums


def record_line(name: str, data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    return f"{name},sha256={digest},{len(data)}"


def write_wheel(path: Path, entries: dict[str, bytes], dist_info: str, executable: str) -> None:
    """Writes the wheel atomically, with a fresh RECORD and regular-file modes pip honours."""
    entries = {n: d for n, d in entries.items() if n != f"{dist_info}/RECORD"}
    record = [record_line(n, d) for n, d in entries.items()] + [f"{dist_info}/RECORD,,"]
    entries[f"{dist_info}/RECORD"] = ("\n".join(record) + "\n").encode()
    fd, partial = tempfile.mkstemp(dir=path.parent, suffix=".whl.partial")
    os.close(fd)
    try:
        with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED) as z:
            for n, d in entries.items():
                info = zipfile.ZipInfo(n, date_time=(2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                # pip and `installer` keep the exec bit only on an entry marked a regular file.
                info.external_attr = (stat.S_IFREG | (0o755 if n == executable else 0o644)) << 16
                z.writestr(info, d)
        os.replace(partial, path)
    finally:
        if os.path.exists(partial):
            os.unlink(partial)


def check(dist: Path, version: str) -> None:
    python = pep440(version)
    wanted = {f"reeval_python-{python}.tar.gz", f"reeval_python-{python}-py3-none-any.whl"}
    wanted |= {f"reeval_python-{python}-py3-none-{tag}.whl" for tag in TAGS.values()}
    found = {p.name for p in dist.iterdir() if p.suffix in (".whl", ".gz")}
    problems = [f"no {n}" for n in sorted(wanted - found)]
    problems += [f"{n} isn't reeval-python {python}'s" for n in sorted(found - wanted)]
    for name in sorted(found & wanted - {f"reeval_python-{python}.tar.gz"}):
        with zipfile.ZipFile(dist / name) as z:
            try:
                manifest = json.loads(z.read(MANIFEST))
            except KeyError:
                problems.append(f"{name} has no {MANIFEST}")
                continue
        names = {t: b.get("name") for t, b in manifest.get("binaries", {}).items()}
        if manifest.get("version") != version or names != {t: asset(version, t) for t in TAGS}:
            problems.append(f"{name} records reeval {manifest.get('version')}'s binaries")
    if problems:
        sys.exit(f"python-wheels: {dist} isn't reeval {version}: " + "; ".join(problems))
    print(f"python-wheels: {len(found)} files, all reeval-python {python} for reeval {version}")


def main(argv: list[str] | None = None) -> None:
    args = sys.argv[1:] if argv is None else argv
    if args[:1] == ["check"]:
        return check(Path(args[1]), args[2])
    pure, release, out = (Path(a) for a in args[:3])
    out.mkdir(parents=True, exist_ok=True)
    sums = parse_sums((release / "SHA256SUMS").read_text())
    with zipfile.ZipFile(pure) as z:
        files = {n: z.read(n) for n in z.namelist()}
    dist_info = next(n.split("/")[0] for n in files if n.endswith(".dist-info/WHEEL"))
    name_version = dist_info.removesuffix(".dist-info")
    version = semver(name_version.split("-")[1])

    missing = [asset(version, t) for t in TAGS if asset(version, t) not in sums]
    if missing:
        others = sorted(n for n in sums if n.startswith("reeval-"))
        sys.exit(
            f"python-wheels: {release} has no {', '.join(missing)} for reeval-python {version}"
            f" (it has {', '.join(others) or 'none'}). The wheel and the binaries must be the"
            " same version: set it with `uv version --frozen` before `uv build`."
        )
    binaries: dict[str, bytes] = {}
    manifest: dict[str, dict[str, object]] = {}
    for target in TAGS:
        name = asset(version, target)
        data = (release / name).read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest != sums[name]:
            sys.exit(f"python-wheels: {name} doesn't match SHA256SUMS")
        binaries[target] = data
        manifest[target] = {"name": name, "sha256": digest, "size": len(data)}
    files[MANIFEST] = (
        json.dumps({"version": version, "binaries": manifest}, indent=2) + "\n"
    ).encode()

    write_wheel(out / pure.name, files, dist_info, executable="")
    if (out / pure.name).resolve() != pure.resolve():
        print(f"python-wheels: {pure.name} (with {MANIFEST}) in {out}")
    for target, tag in TAGS.items():
        inside = f"reeval_python/bin/reeval{'.exe' if target.startswith('windows') else ''}"
        entries = {**files, inside: binaries[target]}
        wheel = entries[f"{dist_info}/WHEEL"].decode()
        wheel = wheel.replace("Root-Is-Purelib: true", "Root-Is-Purelib: false")
        wheel = re.sub(r"^Tag: .*$", "", wheel, flags=re.M).rstrip("\n") + "\n"
        wheel += "".join(f"Tag: py3-none-{t}\n" for t in tag.split("."))
        entries[f"{dist_info}/WHEEL"] = wheel.encode()
        path = out / f"{name_version}-py3-none-{tag}.whl"
        write_wheel(path, entries, dist_info, executable=inside)
        print(f"python-wheels: {path.name} ({path.stat().st_size // 2**20} MB)")


if __name__ == "__main__":
    main()
