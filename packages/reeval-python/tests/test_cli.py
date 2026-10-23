"""The `reeval` command: download, check, cache and run the binary made for this reeval-python."""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
from pathlib import Path

import pytest

from reeval_python import cli
from reeval_python.cli import asset, target

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="the fake binary is a sh script")

FAKE = '#!/bin/sh\necho "fake reeval $* python=$REEVAL_PYTHON"\n'


def release(tmp_path: Path) -> tuple[Path, str]:
    """A release directory with a fake binary for this machine, and its file name."""
    out = tmp_path / "release"
    out.mkdir()
    name = asset("9.9.9", target())
    (out / name).write_text(FAKE)
    digest = hashlib.sha256(FAKE.encode()).hexdigest()
    (out / "SHA256SUMS").write_text(f"{digest}  {name}\n")
    return out, name


def reeval(tmp_path: Path, *args: str, **env: str) -> subprocess.CompletedProcess[str]:
    base = {k: v for k, v in os.environ.items() if not k.startswith("REEVAL_")}
    return subprocess.run(
        [sys.executable, "-m", "reeval_python", *args],
        env={**base, "XDG_CACHE_HOME": str(tmp_path / "cache"), "REEVAL_VERSION": "9.9.9", **env},
        capture_output=True,
        text=True,
    )


def test_downloads_checks_caches_and_runs_the_binary(tmp_path: Path) -> None:
    out, name = release(tmp_path)
    first = reeval(tmp_path, "run", "--dry-run", REEVAL_DOWNLOAD=out.as_uri())
    assert first.returncode == 0, first.stderr
    assert first.stdout.strip() == f"fake reeval run --dry-run python={sys.executable}"
    assert f"downloading {name}" in first.stderr
    assert (tmp_path / "cache" / "reeval" / "bin" / "9.9.9" / name).is_file()

    (out / name).unlink()
    again = reeval(tmp_path, "--version", REEVAL_OFFLINE="1")
    assert again.returncode == 0, again.stderr
    assert again.stdout.startswith("fake reeval --version")
    assert "downloading" not in again.stderr


def test_a_binary_that_does_not_match_sha256sums_is_refused(tmp_path: Path) -> None:
    out, name = release(tmp_path)
    (out / "SHA256SUMS").write_text(f"{'0' * 64}  {name}\n")
    result = reeval(tmp_path, "run", REEVAL_DOWNLOAD=out.as_uri())
    assert result.returncode == 3
    assert "doesn't match SHA256SUMS" in result.stderr
    assert not (tmp_path / "cache" / "reeval" / "bin" / "9.9.9").exists()


def test_offline_without_a_cached_binary_says_where_to_put_one(tmp_path: Path) -> None:
    result = reeval(tmp_path, "run", REEVAL_OFFLINE="1")
    assert result.returncode == 2
    assert "isn't in the cache and REEVAL_OFFLINE is set" in result.stderr
    assert str(tmp_path / "cache" / "reeval" / "bin" / "9.9.9") in result.stderr


def test_a_release_without_binaries_names_the_url(tmp_path: Path) -> None:
    missing = (tmp_path / "nowhere").as_uri()
    result = reeval(tmp_path, "run", REEVAL_DOWNLOAD=missing)
    assert result.returncode == 3
    assert f"Couldn't download {missing}/SHA256SUMS" in result.stderr


def test_reeval_binary_runs_that_binary(tmp_path: Path) -> None:
    binary = tmp_path / "my-reeval"
    binary.write_text(FAKE)
    binary.chmod(0o755)
    result = reeval(tmp_path, "history", REEVAL_BINARY=str(binary), REEVAL_PYTHON="/my/python")
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "fake reeval history python=/my/python"


def test_a_platform_wheel_runs_its_own_binary_unless_a_version_is_asked_for(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    own = tmp_path / "bin" / "reeval"
    own.parent.mkdir()
    own.write_text(FAKE)
    monkeypatch.setattr(cli, "bundled", lambda: own)
    monkeypatch.delenv("REEVAL_BINARY", raising=False)
    monkeypatch.delenv("REEVAL_VERSION", raising=False)
    assert cli.resolve() == own
    monkeypatch.setenv("REEVAL_VERSION", "9.9.9")
    monkeypatch.setenv("REEVAL_OFFLINE", "1")
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    with pytest.raises(cli.ShimError, match="isn't in the cache"):
        cli.resolve()
