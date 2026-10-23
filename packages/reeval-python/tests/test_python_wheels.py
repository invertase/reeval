"""scripts/python-wheels.py: the platform wheels that carry the reeval binary."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import stat
import sys
import zipfile
from pathlib import Path
from types import ModuleType

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "python-wheels.py"
pytestmark = pytest.mark.skipif(not SCRIPT.is_file(), reason="runs from the reeval repository")
DIST = "reeval_python-1.2.3.dist-info"


@pytest.fixture
def wheels(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    monkeypatch.setattr(sys, "dont_write_bytecode", True)
    spec = importlib.util.spec_from_file_location("python_wheels", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def pure(tmp_path: Path, version: str = "1.2.3") -> Path:
    dist = f"reeval_python-{version}.dist-info"
    path = tmp_path / "dist" / f"reeval_python-{version}-py3-none-any.whl"
    path.parent.mkdir()
    (path.parent / f"reeval_python-{version}.tar.gz").write_bytes(b"sdist")
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("reeval_python/__init__.py", "")
        z.writestr(f"{dist}/METADATA", f"Name: reeval-python\nVersion: {version}\n")
        z.writestr(
            f"{dist}/WHEEL", "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
        )
        z.writestr(f"{dist}/RECORD", "")
    return path


def release(tmp_path: Path, wheels: ModuleType, version: str = "1.2.3", skip: str = "") -> Path:
    out = tmp_path / "release"
    out.mkdir()
    sums = []
    for target in wheels.TAGS:
        if target == skip:
            continue
        name = wheels.asset(version, target)
        data = f"binary for {target}".encode()
        (out / name).write_bytes(data)
        # sha256sum writes `*name` in binary mode.
        sums.append(
            f"{hashlib.sha256(data).hexdigest()} {'*' if 'darwin' in target else ' '}{name}"
        )
    (out / "SHA256SUMS").write_text("\n".join(sums) + "\n")
    return out


def test_a_platform_wheel_per_target_with_an_executable_binary(
    tmp_path: Path, wheels: ModuleType
) -> None:
    whl = pure(tmp_path)
    wheels.main([str(whl), str(release(tmp_path, wheels)), str(whl.parent)])
    built = sorted(p.name for p in whl.parent.glob("*.whl"))
    wheels.main(["check", str(whl.parent), "1.2.3"])
    assert len(built) == len(wheels.TAGS) + 1
    assert "reeval_python-1.2.3-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl" in built
    with zipfile.ZipFile(whl.parent / "reeval_python-1.2.3-py3-none-win_amd64.whl") as z:
        assert z.read("reeval_python/bin/reeval.exe") == b"binary for windows-x64"
        assert "Tag: py3-none-win_amd64" in z.read(f"{DIST}/WHEEL").decode()
        assert "Root-Is-Purelib: false" in z.read(f"{DIST}/WHEEL").decode()
    with zipfile.ZipFile(
        whl.parent / "reeval_python-1.2.3-py3-none-musllinux_1_2_aarch64.whl"
    ) as z:
        modes = {i.filename: i.external_attr >> 16 for i in z.infolist()}
        record = z.read(f"{DIST}/RECORD").decode()
    # What pip's zip_item_is_executable and `installer` check before they set the exec bit.
    binary = modes["reeval_python/bin/reeval"]
    assert stat.S_ISREG(binary) and binary & 0o111
    others = [m for n, m in modes.items() if n != "reeval_python/bin/reeval"]
    assert all(stat.S_ISREG(m) and not m & 0o111 for m in others)
    assert "reeval_python/bin/reeval,sha256=" in record
    assert "reeval_python/binaries.json,sha256=" in record


def test_every_wheel_records_each_targets_hash(tmp_path: Path, wheels: ModuleType) -> None:
    whl = pure(tmp_path)
    wheels.main([str(whl), str(release(tmp_path, wheels)), str(whl.parent)])
    for path in whl.parent.glob("*.whl"):
        with zipfile.ZipFile(path) as z:
            manifest = json.loads(z.read("reeval_python/binaries.json"))
        assert manifest["version"] == "1.2.3"
        assert manifest["binaries"]["darwin-arm64"] == {
            "name": "reeval-1.2.3-darwin-arm64",
            "sha256": hashlib.sha256(b"binary for darwin-arm64").hexdigest(),
            "size": len(b"binary for darwin-arm64"),
        }
        assert set(manifest["binaries"]) == set(wheels.TAGS)


def test_binaries_of_another_version_are_refused(tmp_path: Path, wheels: ModuleType) -> None:
    whl = pure(tmp_path)
    with pytest.raises(SystemExit, match="no reeval-1.2.3-linux-x64.*same version"):
        wheels.main([str(whl), str(release(tmp_path, wheels, "1.3.0")), str(tmp_path / "out")])
    assert not list((tmp_path / "out").glob("*.whl"))


def test_a_missing_target_is_refused(tmp_path: Path, wheels: ModuleType) -> None:
    whl = pure(tmp_path)
    with pytest.raises(SystemExit, match="no reeval-1.2.3-windows-x64.exe for reeval-python"):
        wheels.main([str(whl), str(release(tmp_path, wheels, skip="windows-x64")), str(tmp_path)])


def test_a_binary_that_does_not_match_sha256sums_is_refused(
    tmp_path: Path, wheels: ModuleType
) -> None:
    whl = pure(tmp_path)
    out = release(tmp_path, wheels)
    (out / "reeval-1.2.3-linux-arm64").write_bytes(b"tampered")
    with pytest.raises(SystemExit, match="reeval-1.2.3-linux-arm64 doesn't match SHA256SUMS"):
        wheels.main([str(whl), str(out), str(tmp_path / "out")])


@pytest.mark.parametrize(
    ("reeval", "python"),
    [
        ("1.2.3", "1.2.3"),
        ("1.0.0-alpha.2", "1.0.0a2"),
        ("1.0.0-beta.1", "1.0.0b1"),
        ("2.0.0-rc.10", "2.0.0rc10"),
    ],
)
def test_versions_map_both_ways_as_the_launcher_maps_them(
    wheels: ModuleType, reeval: str, python: str
) -> None:
    from reeval_python import cli

    assert wheels.pep440(reeval) == python
    assert wheels.semver(python) == reeval == cli.semver(python)


def test_a_version_with_no_python_spelling_is_refused(wheels: ModuleType) -> None:
    with pytest.raises(SystemExit, match="-alpha.N, -beta.N or -rc.N"):
        wheels.pep440("1.0.0-nightly.3")


def test_a_prerelease_wheel_carries_reevals_prerelease_binaries(
    tmp_path: Path, wheels: ModuleType
) -> None:
    whl = pure(tmp_path, "1.0.0b1")
    wheels.main([str(whl), str(release(tmp_path, wheels, "1.0.0-beta.1")), str(whl.parent)])
    with zipfile.ZipFile(whl.parent / "reeval_python-1.0.0b1-py3-none-macosx_13_0_arm64.whl") as z:
        manifest = json.loads(z.read("reeval_python/binaries.json"))
    assert manifest["version"] == "1.0.0-beta.1"
    assert manifest["binaries"]["darwin-arm64"]["name"] == "reeval-1.0.0-beta.1-darwin-arm64"
    wheels.main(["check", str(whl.parent), "1.0.0-beta.1"])


def test_check_holds_every_file_to_the_release(tmp_path: Path, wheels: ModuleType) -> None:
    whl = pure(tmp_path)
    wheels.main([str(whl), str(release(tmp_path, wheels)), str(whl.parent)])
    with pytest.raises(SystemExit, match="no reeval_python-1.2.4-py3-none-win_amd64.whl"):
        wheels.main(["check", str(whl.parent), "1.2.4"])
    (whl.parent / "reeval_python-1.2.3-py3-none-musllinux_1_2_aarch64.whl").unlink()
    with pytest.raises(SystemExit, match="no reeval_python-1.2.3-py3-none-musllinux_1_2_aarch64"):
        wheels.main(["check", str(whl.parent), "1.2.3"])


def test_check_refuses_a_wheel_without_the_binaries_hashes(
    tmp_path: Path, wheels: ModuleType
) -> None:
    whl = pure(tmp_path)
    plain = whl.read_bytes()
    wheels.main([str(whl), str(release(tmp_path, wheels)), str(whl.parent)])
    # The pure wheel as `uv build` makes it, not the one binary.yml rewrote.
    whl.write_bytes(plain)
    with pytest.raises(SystemExit, match="py3-none-any.whl has no reeval_python/binaries.json"):
        wheels.main(["check", str(whl.parent), "1.2.3"])
