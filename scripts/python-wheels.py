"""reeval-python's release files: the hashes of reeval's binaries, and its platform wheels.

    python3 scripts/python-wheels.py manifest <release dir> <reeval version> <package dir>
    python3 scripts/python-wheels.py check <dist dir> <reeval version>
    uv run --no-project python scripts/python-wheels.py platform <pure .whl> <release dir> <out dir>
    python3 scripts/python-wheels.py check --platform <dir> <reeval version>
    python3 scripts/python-wheels.py verify <dist dir> <SHA256SUMS>

<release dir> holds the binaries and SHA256SUMS as binary.yml builds them, and must have
`reeval-<version>-<target>` for every target. reeval-python's version is reeval's in PEP 440:
reeval 1.0.0-beta.1 is reeval-python 1.0.0b1.

`manifest` writes `binaries.json` (each target's sha256 and size) into the package before
`uv build`, so the sdist and the pure wheel both carry it; the `reeval` console script holds a
download to it. `check` is release.yml's gate before PyPI: <dist dir> must hold exactly that
sdist and pure wheel, each recording reeval <version>'s binaries. `verify` holds every file's
recorded hashes to a release's SHA256SUMS, so PyPI never gets a reeval-python whose binaries
aren't the ones on the release.

`platform` builds a wheel per target from the pure wheel, with the binary added as
`reeval_python/bin/reeval` (`reeval.exe` on Windows), which the console script runs instead of
downloading. They are a CI artifact for the smoke, not published: seven binaries a release would
add about 250 MB to PyPI. `check --platform` holds them to the release the same way. The baseline
x64 builds (no AVX2) are recorded but get no platform wheel.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import stat
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path
from typing import Any

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
# The x64 builds that need no AVX2, which the launcher picks on a CPU without it.
TARGETS = [*TAGS, "linux-x64-baseline", "linux-x64-musl-baseline", "windows-x64-baseline"]
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
    """Writes the wheel atomically, with a fresh RECORD and regular-file modes pip honors."""
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


def manifest_of(path: Path, name: str) -> dict[str, Any] | None:
    """The binaries.json a wheel or sdist carries, or None."""
    if name.endswith(".tar.gz"):
        with tarfile.open(path) as t:
            member = next((m for m in t.getmembers() if m.name.endswith(f"/src/{MANIFEST}")), None)
            data = t.extractfile(member) if member else None
            return json.loads(data.read()) if data else None
    with zipfile.ZipFile(path) as z:
        try:
            return json.loads(z.read(MANIFEST))
        except KeyError:
            return None


def check(dist: Path, version: str, platform: bool = False) -> None:
    python = pep440(version)
    if platform:
        wanted = {f"reeval_python-{python}-py3-none-{tag}.whl" for tag in TAGS.values()}
    else:
        wanted = {f"reeval_python-{python}.tar.gz", f"reeval_python-{python}-py3-none-any.whl"}
    found = {p.name for p in dist.iterdir() if p.suffix in (".whl", ".gz")}
    problems = [f"no {n}" for n in sorted(wanted - found)]
    problems += [f"{n} isn't reeval-python {python}'s" for n in sorted(found - wanted)]
    for name in sorted(found & wanted):
        manifest = manifest_of(dist / name, name)
        if manifest is None:
            problems.append(f"{name} has no {MANIFEST}")
            continue
        names = {t: b.get("name") for t, b in manifest.get("binaries", {}).items()}
        if manifest.get("version") != version or names != {t: asset(version, t) for t in TARGETS}:
            problems.append(f"{name} records reeval {manifest.get('version')}'s binaries")
    if problems:
        sys.exit(f"python-wheels: {dist} isn't reeval {version}: " + "; ".join(problems))
    print(f"python-wheels: {len(found)} files, all reeval-python {python} for reeval {version}")


def verify(dist: Path, sums_file: Path) -> None:
    sums = parse_sums(sums_file.read_text())
    files = sorted(p for p in dist.iterdir() if p.suffix in (".whl", ".gz"))
    problems = [] if files else [f"{dist} has no sdist or wheel"]
    for path in files:
        manifest = manifest_of(path, path.name)
        if manifest is None:
            problems.append(f"{path.name} has no {MANIFEST}")
            continue
        for target, binary in sorted(manifest.get("binaries", {}).items()):
            name = binary.get("name")
            listed = sums.get(name)
            if listed is None:
                problems.append(f"{path.name} records {name} ({target}), which isn't listed")
            elif listed != binary.get("sha256"):
                problems.append(f"{path.name} records {name} as {binary.get('sha256')}, not {listed}")
    if problems:
        sys.exit(f"python-wheels: {dist} doesn't match {sums_file}: " + "; ".join(problems))
    print(f"python-wheels: {len(files)} files record the binaries {sums_file} lists")


def binaries(release: Path, version: str) -> dict[str, bytes]:
    """Every target's binary of reeval `version`, each matching the release's SHA256SUMS."""
    sums = parse_sums((release / "SHA256SUMS").read_text())
    missing = [asset(version, t) for t in TARGETS if asset(version, t) not in sums]
    if missing:
        others = sorted(n for n in sums if n.startswith("reeval-"))
        sys.exit(
            f"python-wheels: {release} has no {', '.join(missing)} for reeval {version}"
            f" (it has {', '.join(others) or 'none'}). reeval-python and the binaries must be the"
            " same version: set it with `uv version --frozen` before `uv build`."
        )
    found = {}
    for target in TARGETS:
        name = asset(version, target)
        data = (release / name).read_bytes()
        if hashlib.sha256(data).hexdigest() != sums[name]:
            sys.exit(f"python-wheels: {name} doesn't match SHA256SUMS")
        found[target] = data
    return found


def manifest(release: Path, version: str, package: Path) -> None:
    pep440(version)
    entries = {
        target: {
            "name": asset(version, target),
            "sha256": hashlib.sha256(data).hexdigest(),
            "size": len(data),
        }
        for target, data in binaries(release, version).items()
    }
    path = package / "binaries.json"
    path.write_text(json.dumps({"version": version, "binaries": entries}, indent=2) + "\n")
    print(f"python-wheels: {path} records reeval {version}'s {len(entries)} binaries")


def platform_wheels(pure: Path, release: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(pure) as z:
        files = {n: z.read(n) for n in z.namelist()}
    dist_info = next(n.split("/")[0] for n in files if n.endswith(".dist-info/WHEEL"))
    name_version = dist_info.removesuffix(".dist-info")
    version = semver(name_version.split("-")[1])
    found = binaries(release, version)
    recorded = json.loads(files[MANIFEST]) if MANIFEST in files else None
    if recorded is None or recorded.get("version") != version:
        sys.exit(
            f"python-wheels: {pure.name} records no reeval {version} binaries: run `manifest`"
            " before `uv build`"
        )
    for target, data in found.items():
        if recorded["binaries"].get(target, {}).get("sha256") != hashlib.sha256(data).hexdigest():
            sys.exit(
                f"python-wheels: {asset(version, target)} isn't the binary {pure.name} records"
            )
    for target, tag in TAGS.items():
        inside = f"reeval_python/bin/reeval{'.exe' if target.startswith('windows') else ''}"
        entries = {**files, inside: found[target]}
        wheel = entries[f"{dist_info}/WHEEL"].decode()
        wheel = wheel.replace("Root-Is-Purelib: true", "Root-Is-Purelib: false")
        wheel = re.sub(r"^Tag: .*$", "", wheel, flags=re.M).rstrip("\n") + "\n"
        wheel += "".join(f"Tag: py3-none-{t}\n" for t in tag.split("."))
        entries[f"{dist_info}/WHEEL"] = wheel.encode()
        path = out / f"{name_version}-py3-none-{tag}.whl"
        write_wheel(path, entries, dist_info, executable=inside)
        print(f"python-wheels: {path.name} ({path.stat().st_size // 2**20} MB)")


def main(argv: list[str] | None = None) -> None:
    args = sys.argv[1:] if argv is None else argv
    match args:
        case ["manifest", release, version, package]:
            manifest(Path(release), version, Path(package))
        case ["check", "--platform", dist, version]:
            check(Path(dist), version, platform=True)
        case ["check", dist, version]:
            check(Path(dist), version)
        case ["verify", dist, sums]:
            verify(Path(dist), Path(sums))
        case ["platform", pure, release, out]:
            platform_wheels(Path(pure), Path(release), Path(out))
        case _:
            sys.exit(__doc__)


if __name__ == "__main__":
    main()
