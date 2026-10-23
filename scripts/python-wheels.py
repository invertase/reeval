"""Builds reeval-python's platform wheels: the pure wheel plus each target's reeval binary.

    uv run --no-project python scripts/python-wheels.py <pure .whl> <release dir> <out dir>

<release dir> holds the binaries and SHA256SUMS as binary.yml builds them. Each platform wheel is
the pure wheel with `reeval_python/bin/reeval` (`reeval.exe` on Windows) added and its tag
changed; the `reeval` console script runs that binary. The pure wheel stays the fallback for
any other platform, where the console script downloads the binary instead.
"""

from __future__ import annotations

import base64
import hashlib
import re
import sys
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


def record_line(name: str, data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    return f"{name},sha256={digest},{len(data)}"


def main() -> None:
    pure, release, out = (Path(a) for a in sys.argv[1:4])
    out.mkdir(parents=True, exist_ok=True)
    sums = dict(
        reversed(line.split()) for line in (release / "SHA256SUMS").read_text().splitlines()
    )
    with zipfile.ZipFile(pure) as z:
        files = {n: z.read(n) for n in z.namelist()}
    dist_info = next(n.split("/")[0] for n in files if n.endswith(".dist-info/WHEEL"))
    name_version = dist_info.removesuffix(".dist-info")
    for target, tag in TAGS.items():
        binary = next((f for f in sums if re.fullmatch(rf"reeval-.+-{target}(\.exe)?", f)), None)
        if binary is None:
            print(f"python-wheels: no {target} binary in {release}, skipped")
            continue
        data = (release / binary).read_bytes()
        if hashlib.sha256(data).hexdigest() != sums[binary]:
            sys.exit(f"python-wheels: {binary} doesn't match SHA256SUMS")
        inside = f"reeval_python/bin/reeval{'.exe' if target.startswith('windows') else ''}"
        entries = {n: d for n, d in files.items() if not n.endswith("/RECORD")}
        entries[inside] = data
        wheel = entries[f"{dist_info}/WHEEL"].decode()
        wheel = wheel.replace("Root-Is-Purelib: true", "Root-Is-Purelib: false")
        wheel = re.sub(r"^Tag: .*$", "", wheel, flags=re.M).rstrip("\n") + "\n"
        wheel += "".join(f"Tag: py3-none-{t}\n" for t in tag.split("."))
        entries[f"{dist_info}/WHEEL"] = wheel.encode()
        record = [record_line(n, d) for n, d in entries.items()] + [f"{dist_info}/RECORD,,"]
        entries[f"{dist_info}/RECORD"] = ("\n".join(record) + "\n").encode()
        path = out / f"{name_version}-py3-none-{tag}.whl"
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
            for n, d in entries.items():
                info = zipfile.ZipInfo(n, date_time=(2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (0o755 if n == inside else 0o644) << 16
                z.writestr(info, d)
        print(f"python-wheels: {path.name} ({path.stat().st_size // 2**20} MB)")


if __name__ == "__main__":
    main()
