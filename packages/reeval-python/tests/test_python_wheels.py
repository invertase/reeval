"""scripts/python-wheels.py: the binary hashes reeval-python ships, and its platform wheels."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import re
import stat
import sys
import tarfile
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


def release(tmp_path: Path, wheels: ModuleType, version: str = "1.2.3", skip: str = "") -> Path:
    out = tmp_path / "release"
    out.mkdir()
    sums = []
    for target in wheels.TARGETS:
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


def build(tmp_path: Path, wheels: ModuleType, version: str = "1.2.3", reeval: str = "") -> Path:
    """The sdist and pure wheel as binary.yml builds them: `manifest`, then `uv build`."""
    package = tmp_path / "package"
    package.mkdir()
    wheels.main(
        [
            "manifest",
            str(release(tmp_path, wheels, reeval or version)),
            reeval or version,
            str(package),
        ]
    )
    recorded = (package / "binaries.json").read_bytes()
    dist = f"reeval_python-{version}.dist-info"
    out = tmp_path / "dist"
    out.mkdir()
    with tarfile.open(out / f"reeval_python-{version}.tar.gz", "w:gz") as t:
        info = tarfile.TarInfo(f"reeval_python-{version}/src/reeval_python/binaries.json")
        info.size = len(recorded)
        t.addfile(info, io.BytesIO(recorded))
    with zipfile.ZipFile(out / f"reeval_python-{version}-py3-none-any.whl", "w") as z:
        z.writestr("reeval_python/__init__.py", "")
        z.writestr("reeval_python/binaries.json", recorded)
        z.writestr(f"{dist}/METADATA", f"Name: reeval-python\nVersion: {version}\n")
        z.writestr(
            f"{dist}/WHEEL", "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
        )
        z.writestr(f"{dist}/RECORD", "")
    return out


def test_the_manifest_records_each_targets_hash(tmp_path: Path, wheels: ModuleType) -> None:
    dist = build(tmp_path, wheels)
    wheels.main(["check", str(dist), "1.2.3"])
    manifest = json.loads((tmp_path / "package" / "binaries.json").read_text())
    assert manifest["version"] == "1.2.3"
    assert manifest["binaries"]["darwin-arm64"] == {
        "name": "reeval-1.2.3-darwin-arm64",
        "sha256": hashlib.sha256(b"binary for darwin-arm64").hexdigest(),
        "size": len(b"binary for darwin-arm64"),
    }
    assert set(manifest["binaries"]) == set(wheels.TAGS) | {
        "linux-x64-baseline",
        "linux-x64-musl-baseline",
        "windows-x64-baseline",
    }


def test_a_missing_baseline_build_is_refused(tmp_path: Path, wheels: ModuleType) -> None:
    out = release(tmp_path, wheels, skip="linux-x64-musl-baseline")
    with pytest.raises(SystemExit, match="no reeval-1.2.3-linux-x64-musl-baseline for"):
        wheels.main(["manifest", str(out), "1.2.3", str(tmp_path)])


def test_verify_holds_the_dist_to_the_releases_sha256sums(
    tmp_path: Path, wheels: ModuleType, capsys: pytest.CaptureFixture[str]
) -> None:
    dist = build(tmp_path, wheels)
    sums = tmp_path / "release" / "SHA256SUMS"
    wheels.main(["verify", str(dist), str(sums)])
    assert "2 files record the binaries" in capsys.readouterr().out
    # A rebuild uploaded over the release: the published SDK would refuse every download.
    rebuilt = sums.read_text().replace(
        hashlib.sha256(b"binary for linux-x64-baseline").hexdigest(), "0" * 64
    )
    sums.write_text(rebuilt)
    with pytest.raises(SystemExit) as refused:
        wheels.main(["verify", str(dist), str(sums)])
    message = str(refused.value)
    assert "reeval_python-1.2.3-py3-none-any.whl records reeval-1.2.3-linux-x64-baseline" in message
    assert "reeval_python-1.2.3.tar.gz records reeval-1.2.3-linux-x64-baseline" in message
    assert f"not {'0' * 64}" in message
    sums.write_text("\n".join(rebuilt.splitlines()[1:]) + "\n")
    with pytest.raises(SystemExit, match="which isn't listed"):
        wheels.main(["verify", str(dist), str(sums)])
    for path in dist.iterdir():
        path.unlink()
    with pytest.raises(SystemExit, match="has no sdist or wheel"):
        wheels.main(["verify", str(dist), str(sums)])


def test_binaries_of_another_version_are_refused(tmp_path: Path, wheels: ModuleType) -> None:
    with pytest.raises(SystemExit, match="no reeval-1.2.3-linux-x64.*same version"):
        wheels.main(["manifest", str(release(tmp_path, wheels, "1.3.0")), "1.2.3", str(tmp_path)])
    assert not (tmp_path / "binaries.json").exists()


def test_a_missing_target_is_refused(tmp_path: Path, wheels: ModuleType) -> None:
    out = release(tmp_path, wheels, skip="windows-x64")
    with pytest.raises(SystemExit, match="no reeval-1.2.3-windows-x64.exe for reeval 1.2.3"):
        wheels.main(["manifest", str(out), "1.2.3", str(tmp_path)])


def test_a_binary_that_does_not_match_sha256sums_is_refused(
    tmp_path: Path, wheels: ModuleType
) -> None:
    out = release(tmp_path, wheels)
    (out / "reeval-1.2.3-linux-arm64").write_bytes(b"tampered")
    with pytest.raises(SystemExit, match="reeval-1.2.3-linux-arm64 doesn't match SHA256SUMS"):
        wheels.main(["manifest", str(out), "1.2.3", str(tmp_path)])


def test_check_holds_the_published_files_to_the_release(tmp_path: Path, wheels: ModuleType) -> None:
    dist = build(tmp_path, wheels)
    with pytest.raises(SystemExit, match="no reeval_python-1.2.4-py3-none-any.whl"):
        wheels.main(["check", str(dist), "1.2.4"])
    (dist / "reeval_python-1.2.3-py3-none-win_amd64.whl").write_bytes(b"")
    with pytest.raises(SystemExit, match="win_amd64.whl isn't reeval-python 1.2.3's"):
        wheels.main(["check", str(dist), "1.2.3"])
    (dist / "reeval_python-1.2.3-py3-none-win_amd64.whl").unlink()
    (dist / "reeval_python-1.2.3.tar.gz").unlink()
    with pytest.raises(SystemExit, match="no reeval_python-1.2.3.tar.gz"):
        wheels.main(["check", str(dist), "1.2.3"])


@pytest.mark.parametrize(
    "name", ["reeval_python-1.2.3-py3-none-any.whl", "reeval_python-1.2.3.tar.gz"]
)
def test_check_refuses_a_file_without_the_binaries_hashes(
    tmp_path: Path, wheels: ModuleType, name: str
) -> None:
    dist = tmp_path / "dist"
    dist.mkdir()
    with zipfile.ZipFile(dist / "reeval_python-1.2.3-py3-none-any.whl", "w") as z:
        z.writestr("reeval_python/__init__.py", "")
    with tarfile.open(dist / "reeval_python-1.2.3.tar.gz", "w:gz") as t:
        t.addfile(tarfile.TarInfo("reeval_python-1.2.3/PKG-INFO"), io.BytesIO(b""))
    with pytest.raises(SystemExit, match=f"{re.escape(name)} has no reeval_python/binaries.json"):
        wheels.main(["check", str(dist), "1.2.3"])


def test_check_refuses_a_file_recording_another_release(tmp_path: Path, wheels: ModuleType) -> None:
    dist = build(tmp_path, wheels, version="1.2.3", reeval="1.2.2")
    with pytest.raises(SystemExit, match="any.whl records reeval 1.2.2's binaries"):
        wheels.main(["check", str(dist), "1.2.3"])


def test_a_platform_wheel_per_target_with_an_executable_binary(
    tmp_path: Path, wheels: ModuleType
) -> None:
    whl = build(tmp_path, wheels) / "reeval_python-1.2.3-py3-none-any.whl"
    out = tmp_path / "platform"
    wheels.main(["platform", str(whl), str(tmp_path / "release"), str(out)])
    wheels.main(["check", "--platform", str(out), "1.2.3"])
    built = sorted(p.name for p in out.glob("*.whl"))
    assert len(built) == len(wheels.TAGS)
    assert "reeval_python-1.2.3-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl" in built
    with zipfile.ZipFile(out / "reeval_python-1.2.3-py3-none-win_amd64.whl") as z:
        assert z.read("reeval_python/bin/reeval.exe") == b"binary for windows-x64"
        assert "Tag: py3-none-win_amd64" in z.read(f"{DIST}/WHEEL").decode()
        assert "Root-Is-Purelib: false" in z.read(f"{DIST}/WHEEL").decode()
    with zipfile.ZipFile(out / "reeval_python-1.2.3-py3-none-musllinux_1_2_aarch64.whl") as z:
        modes = {i.filename: i.external_attr >> 16 for i in z.infolist()}
        record = z.read(f"{DIST}/RECORD").decode()
    # What pip's zip_item_is_executable and `installer` check before they set the exec bit.
    binary = modes["reeval_python/bin/reeval"]
    assert stat.S_ISREG(binary) and binary & 0o111
    others = [m for n, m in modes.items() if n != "reeval_python/bin/reeval"]
    assert all(stat.S_ISREG(m) and not m & 0o111 for m in others)
    assert "reeval_python/bin/reeval,sha256=" in record
    assert "reeval_python/binaries.json,sha256=" in record
    (out / "reeval_python-1.2.3-py3-none-musllinux_1_2_x86_64.whl").unlink()
    with pytest.raises(SystemExit, match="no reeval_python-1.2.3-py3-none-musllinux_1_2_x86_64"):
        wheels.main(["check", "--platform", str(out), "1.2.3"])


def test_a_platform_wheel_needs_the_binaries_its_pure_wheel_records(
    tmp_path: Path, wheels: ModuleType
) -> None:
    whl = build(tmp_path, wheels) / "reeval_python-1.2.3-py3-none-any.whl"
    rel = tmp_path / "release"
    (rel / "reeval-1.2.3-darwin-x64").write_bytes(b"rebuilt")
    sums = (rel / "SHA256SUMS").read_text().splitlines()
    sums = [
        f"{hashlib.sha256(b'rebuilt').hexdigest()}  reeval-1.2.3-darwin-x64"
        if line.endswith("darwin-x64")
        else line
        for line in sums
    ]
    (rel / "SHA256SUMS").write_text("\n".join(sums) + "\n")
    with pytest.raises(SystemExit, match="reeval-1.2.3-darwin-x64 isn't the binary"):
        wheels.main(["platform", str(whl), str(rel), str(tmp_path / "out")])


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


def test_a_prerelease_carries_reevals_prerelease_binaries(
    tmp_path: Path, wheels: ModuleType
) -> None:
    dist = build(tmp_path, wheels, version="1.0.0b1", reeval="1.0.0-beta.1")
    wheels.main(["check", str(dist), "1.0.0-beta.1"])
    out = tmp_path / "platform"
    wheels.main(
        [
            "platform",
            str(dist / "reeval_python-1.0.0b1-py3-none-any.whl"),
            str(tmp_path / "release"),
            str(out),
        ]
    )
    with zipfile.ZipFile(out / "reeval_python-1.0.0b1-py3-none-macosx_13_0_arm64.whl") as z:
        manifest = json.loads(z.read("reeval_python/binaries.json"))
    assert manifest["version"] == "1.0.0-beta.1"
    assert manifest["binaries"]["darwin-arm64"]["name"] == "reeval-1.0.0-beta.1-darwin-arm64"
    wheels.main(["check", "--platform", str(out), "1.0.0-beta.1"])
