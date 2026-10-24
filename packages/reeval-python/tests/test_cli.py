"""The `reeval` command: download, check, cache and run the binary made for this reeval-python."""

from __future__ import annotations

import hashlib
import http.server
import json
import os
import signal
import stat
import subprocess
import sys
import textwrap
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

from reeval_python import cli
from reeval_python.cli import asset, target

posix = pytest.mark.skipif(sys.platform == "win32", reason="the fake binary is a sh script")

FAKE = '#!/bin/sh\necho "fake reeval $* python=$REEVAL_PYTHON"\n'


def release(tmp_path: Path, version: str = "9.9.9") -> tuple[Path, str]:
    """A release directory with a fake binary for this machine, and its file name."""
    out = tmp_path / "release"
    out.mkdir(exist_ok=True)
    name = asset(version, target())
    (out / name).write_text(FAKE)
    digest = hashlib.sha256(FAKE.encode()).hexdigest()
    (out / "SHA256SUMS").write_text(f"{digest} *{name}\n")
    return out, name


def reeval(tmp_path: Path, *args: str, **env: str) -> subprocess.CompletedProcess[str]:
    base = {
        k: v for k, v in os.environ.items() if not k.startswith("REEVAL_") and k != "VIRTUAL_ENV"
    }
    return subprocess.run(
        [sys.executable, "-m", "reeval_python", *args],
        env={**base, "XDG_CACHE_HOME": str(tmp_path / "cache"), "REEVAL_VERSION": "9.9.9", **env},
        capture_output=True,
        text=True,
        cwd=tmp_path,
    )


@pytest.fixture
def clean(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """No REEVAL_* or venv from the outside, an empty cache, and no bundled binary."""
    for key in list(os.environ):
        if key.startswith("REEVAL_") or key == "VIRTUAL_ENV":
            monkeypatch.delenv(key)
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    monkeypatch.setattr(cli, "bundled", lambda: tmp_path / "no-bundled-binary")
    monkeypatch.chdir(tmp_path)
    return tmp_path


def record(monkeypatch: pytest.MonkeyPatch, version: str, data: bytes) -> None:
    """Pretends this reeval-python was released as `version` with `data` as this target's binary."""
    entry = {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
    monkeypatch.setattr(cli, "own_version", lambda: version)
    monkeypatch.setattr(
        cli, "released", lambda: {"version": version, "binaries": {target(): entry}}
    )


@posix
def test_downloads_checks_caches_and_runs_the_binary(tmp_path: Path) -> None:
    out, name = release(tmp_path)
    first = reeval(tmp_path, "run", "--dry-run", REEVAL_DOWNLOAD=out.as_uri())
    assert first.returncode == 0, first.stderr
    assert first.stdout.strip() == f"fake reeval run --dry-run python={sys.executable}"
    assert f"downloading {name}" in first.stderr
    assert "checked against" in first.stderr and "SHA256SUMS only" in first.stderr
    cached = tmp_path / "cache" / "reeval" / "bin" / "9.9.9"
    assert sorted(p.name for p in cached.iterdir()) == [name, f"{name}.sha256"]

    (out / name).unlink()
    again = reeval(tmp_path, "--version", REEVAL_OFFLINE="1")
    assert again.returncode == 0, again.stderr
    assert again.stdout.startswith("fake reeval --version")
    assert "downloading" not in again.stderr


@posix
def test_a_binary_that_does_not_match_sha256sums_is_refused(tmp_path: Path) -> None:
    out, name = release(tmp_path)
    (out / "SHA256SUMS").write_text(f"{'0' * 64}  {name}\n")
    result = reeval(tmp_path, "run", REEVAL_DOWNLOAD=out.as_uri())
    assert result.returncode == 3
    assert "doesn't match SHA256SUMS" in result.stderr
    assert not (tmp_path / "cache" / "reeval" / "bin" / "9.9.9").exists()


def test_the_download_is_held_to_the_hash_the_wheel_was_released_with(
    clean: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    out, name = release(clean)
    record(monkeypatch, "9.9.9", b"the real binary")
    monkeypatch.setenv("REEVAL_DOWNLOAD", out.as_uri())
    # SHA256SUMS and the binary agree, but were replaced together: the recorded hash decides.
    with pytest.raises(cli.ShimError, match="released with") as refused:
        cli.resolve()
    assert refused.value.code == 3
    (out / "SHA256SUMS").write_text(f"{hashlib.sha256(b'the real binary').hexdigest()}  {name}\n")
    with pytest.raises(cli.ShimError, match="the sha256 reeval-python 9.9.9 records"):
        cli.resolve()
    (out / name).write_bytes(b"the real binary")
    monkeypatch.setattr(cli, "check_starts", lambda binary, name: None)
    assert cli.resolve().read_bytes() == b"the real binary"


def test_with_a_recorded_hash_the_release_must_agree_with_it(
    clean: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    out, name = release(clean)
    record(monkeypatch, "9.9.9", FAKE.encode())
    monkeypatch.setenv("REEVAL_DOWNLOAD", out.as_uri())
    assert cli.resolve().read_text() == FAKE
    assert "SHA256SUMS only" not in capsys.readouterr().err


@posix
def test_a_cached_binary_that_changed_is_downloaded_again(
    clean: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    out, name = release(clean)
    record(monkeypatch, "9.9.9", FAKE.encode())
    monkeypatch.setenv("REEVAL_DOWNLOAD", out.as_uri())
    cached = clean / "cache" / "reeval" / "bin" / "9.9.9" / name
    cached.parent.mkdir(parents=True)
    cached.write_text("truncated")
    assert cli.resolve() == cached
    assert cached.read_text() == FAKE
    # The same size as the binary checked, but not it, a clock tick later.
    time.sleep(0.05)
    cached.write_text(FAKE.replace("fake", "evil"))
    assert cli.resolve() == cached
    assert cached.read_text() == FAKE
    cached.write_bytes(b"")
    monkeypatch.setenv("REEVAL_OFFLINE", "1")
    with pytest.raises(cli.ShimError, match="isn't in the cache"):
        cli.resolve()
    assert not cached.exists()


@posix
def test_a_cached_binary_is_trusted_by_its_marker_until_it_changes(
    clean: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    out, name = release(clean)
    monkeypatch.setenv("REEVAL_VERSION", "9.9.9")
    monkeypatch.setenv("REEVAL_DOWNLOAD", out.as_uri())
    cached = cli.resolve()
    assert cli._marker(cached).read_text().startswith(hashlib.sha256(FAKE.encode()).hexdigest())
    monkeypatch.setattr(cli, "sha256", lambda path: pytest.fail("hashed a marked binary"))
    monkeypatch.setenv("REEVAL_OFFLINE", "1")
    assert cli.resolve() == cached
    # With no hash recorded for it, a binary changed since its marker can't be checked again.
    time.sleep(0.05)
    cached.write_text(FAKE.replace("fake", "evil"))
    with pytest.raises(cli.ShimError, match="isn't in the cache"):
        cli.resolve()


@posix
def test_a_download_that_does_not_start_is_reported_and_not_kept(
    clean: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    out, name = release(clean)
    crash = '#!/bin/sh\necho "Illegal instruction" >&2\nkill -ILL $$\n'
    (out / name).write_text(crash)
    (out / "SHA256SUMS").write_text(f"{hashlib.sha256(crash.encode()).hexdigest()}  {name}\n")
    monkeypatch.setenv("REEVAL_VERSION", "9.9.9")
    monkeypatch.setenv("REEVAL_DOWNLOAD", out.as_uri())
    with pytest.raises(cli.ShimError) as error:
        cli.resolve()
    assert error.value.code == 3
    assert f"{name} doesn't start on this machine (killed by SIGILL" in str(error.value)
    assert not (clean / "cache" / "reeval" / "bin" / "9.9.9" / name).exists()


def test_exit_codes_are_described() -> None:
    assert cli.describe_exit(-4) == "killed by SIGILL"
    assert cli.describe_exit(0xC000001D) == "an illegal instruction"
    assert cli.describe_exit(2) == "exit 2"


def test_a_download_cut_short_is_a_message_not_a_traceback(
    clean: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class Short:
        def __enter__(self) -> Short:
            return self

        def __exit__(self, *args: object) -> None:
            pass

        def read(self) -> bytes:
            raise cli.http.client.IncompleteRead(b"x" * 5000, 29995000)

    class Opener:
        def open(self, url: str, timeout: int) -> Short:
            return Short()

    monkeypatch.setattr(cli.urllib.request, "build_opener", lambda *handlers: Opener())
    with pytest.raises(cli.ShimError, match="Couldn't download https://x.test/a") as error:
        cli._fetch("https://x.test/a")
    assert error.value.code == 3


def test_ctrl_c_while_downloading_exits_130_quietly(
    clean: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def interrupted() -> Path:
        raise KeyboardInterrupt

    monkeypatch.setattr(cli, "resolve", interrupted)
    with pytest.raises(SystemExit) as exited:
        cli.main(["run"])
    assert exited.value.code == 130
    assert capsys.readouterr().err == ""


@posix
def test_offline_without_a_cached_binary_says_where_to_put_one(tmp_path: Path) -> None:
    result = reeval(tmp_path, "run", REEVAL_OFFLINE="1")
    assert result.returncode == 2
    assert "isn't in the cache and REEVAL_OFFLINE is set" in result.stderr
    assert str(tmp_path / "cache" / "reeval" / "bin" / "9.9.9") in result.stderr


@posix
def test_a_release_without_binaries_names_the_url(tmp_path: Path) -> None:
    missing = (tmp_path / "nowhere").as_uri()
    result = reeval(tmp_path, "run", REEVAL_DOWNLOAD=missing)
    assert result.returncode == 3
    assert f"Couldn't download {missing}/SHA256SUMS" in result.stderr


@pytest.fixture
def server(tmp_path: Path) -> Iterator[str]:
    """An http server whose /moved redirects to an http URL."""

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            super().__init__(*args, directory=str(tmp_path / "release"), **kwargs)

        def log_message(self, *args):  # type: ignore[no-untyped-def]
            pass

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def test_an_http_mirror_works_with_a_warning(
    clean: Path, server: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    release(clean)
    monkeypatch.setenv("REEVAL_VERSION", "9.9.9")
    monkeypatch.setenv("REEVAL_DOWNLOAD", server)
    assert cli.resolve().read_text() == FAKE
    assert "which isn't https" in capsys.readouterr().err


def test_a_redirect_from_https_to_http_is_refused(server: str) -> None:
    class Request:
        full_url = "https://github.com/invertase/reeval/releases/download/v1/SHA256SUMS"

    handler = cli._NoDowngrade()
    with pytest.raises(cli.urllib.error.URLError, match="isn't https"):
        handler.redirect_request(Request(), None, 302, "Found", {}, f"{server}/SHA256SUMS")
    assert handler.redirect_request(
        cli.urllib.request.Request(Request.full_url), None, 302, "Found", {}, "https://x.test/a"
    )


@posix
def test_reeval_binary_runs_that_binary(tmp_path: Path) -> None:
    binary = tmp_path / "my-reeval"
    binary.write_text(FAKE)
    binary.chmod(0o755)
    result = reeval(tmp_path, "history", REEVAL_BINARY=str(binary), REEVAL_PYTHON="/my/python")
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "fake reeval history python=/my/python"


def test_reeval_binary_naming_the_launcher_is_refused(
    clean: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    launcher = clean / "reeval"
    launcher.write_text(f"#!{sys.executable}\nfrom reeval_python.cli import main\nmain()\n")
    monkeypatch.setenv("REEVAL_BINARY", str(launcher))
    with pytest.raises(cli.ShimError, match="this `reeval` command") as refused:
        cli.resolve()
    assert refused.value.code == 2


def test_reeval_binary_naming_a_copy_of_the_launcher_is_refused(
    clean: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    launcher = clean / "reeval.exe"
    launcher.write_bytes(b"MZ windows launcher")
    monkeypatch.setattr(cli, "launchers", lambda: [launcher])
    monkeypatch.setenv("REEVAL_BINARY", str(launcher))
    with pytest.raises(cli.ShimError, match="this `reeval` command"):
        cli.resolve()


def test_a_platform_wheel_runs_its_own_binary_unless_another_version_is_asked_for(
    clean: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    own = clean / "bin" / "reeval"
    own.parent.mkdir()
    own.write_text(FAKE)
    own.chmod(0o755)
    monkeypatch.setattr(cli, "bundled", lambda: own)
    monkeypatch.setattr(cli, "own_version", lambda: "1.2.3")
    assert cli.resolve() == own
    # REEVAL_VERSION exported for install.sh, naming this same version, changes nothing.
    monkeypatch.setenv("REEVAL_VERSION", "v1.2.3")
    assert cli.resolve() == own
    monkeypatch.setenv("REEVAL_VERSION", "9.9.9")
    monkeypatch.setenv("REEVAL_OFFLINE", "1")
    with pytest.raises(cli.ShimError, match="isn't in the cache"):
        cli.resolve()


@posix
def test_a_bundled_binary_installed_without_its_exec_bit_gets_it(
    clean: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    own = clean / "bin" / "reeval"
    own.parent.mkdir()
    own.write_text(FAKE)
    own.chmod(0o644)
    monkeypatch.setattr(cli, "bundled", lambda: own)
    assert cli.resolve() == own
    assert os.access(own, os.X_OK)


@posix
def test_a_binary_that_will_not_run_is_reported_and_dropped_from_the_cache(
    clean: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    name = asset("9.9.9", target())
    cached = clean / "cache" / "reeval" / "bin" / "9.9.9" / name
    cached.parent.mkdir(parents=True)
    cached.write_bytes(b"\x7fELF truncated")
    cached.chmod(0o755)
    cli.mark_verified(cached, hashlib.sha256(b"\x7fELF truncated").hexdigest())
    monkeypatch.setenv("REEVAL_VERSION", "9.9.9")
    with pytest.raises(SystemExit) as exited:
        cli.main(["--version"])
    assert exited.value.code == 3
    err = capsys.readouterr().err
    assert err.startswith(f"reeval: Couldn't run {cached}: Exec format error.")
    assert "removed from the cache" in err and "REEVAL_BINARY" in err
    assert not cached.exists()


def test_a_cache_it_cannot_write_is_reported_and_leaves_nothing(
    clean: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    dest = clean / "cache" / "bin" / "reeval"

    def full(fd: int) -> None:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(cli.os, "fsync", full)
    with pytest.raises(cli.ShimError, match="Couldn't write .*No space left on device") as error:
        cli.store(b"binary", dest, "digest")
    assert error.value.code == 3
    assert list(dest.parent.iterdir()) == []


def test_concurrent_downloads_never_share_a_partial_file(
    clean: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    dest = clean / "bin" / "reeval"
    seen = []
    replace = os.replace

    def watch(src: str, dst: Path) -> None:
        seen.append(src)
        replace(src, dst)

    monkeypatch.setattr(cli.os, "replace", watch)
    cli.store(b"a", dest, hashlib.sha256(b"a").hexdigest())
    cli.store(b"a", dest, hashlib.sha256(b"a").hexdigest())
    assert len(set(seen)) == 2 and all(s.endswith(".partial") for s in seen)
    assert [p.name for p in dest.parent.iterdir()] == ["reeval"]


def test_a_binary_another_run_already_started_is_used(
    clean: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    dest = clean / "bin" / "reeval.exe"
    dest.parent.mkdir()
    dest.write_bytes(b"binary")

    def busy(src: str, dst: Path) -> None:
        raise PermissionError(13, "Access is denied")

    monkeypatch.setattr(cli.os, "replace", busy)
    cli.store(b"binary", dest, hashlib.sha256(b"binary").hexdigest())
    assert [p.name for p in dest.parent.iterdir()] == ["reeval.exe"]
    with pytest.raises(cli.ShimError, match="Access is denied"):
        cli.store(b"other", dest, hashlib.sha256(b"other").hexdigest())


def commands(answers: dict[str, tuple[int, str] | None]) -> object:
    """A fake `_command`: each command's exit code and output, by its first word."""
    return lambda args: answers.get(args[0])


@pytest.mark.parametrize(
    ("getconf", "ldd", "loader", "expected"),
    [
        ((0, "glibc 2.41\n"), (0, "ldd (GNU libc) 2.41"), True, False),
        # Debian's `musl` package puts /lib/ld-musl-*.so.1 on a glibc system.
        ((1, ""), (0, "ldd (Debian GLIBC 2.36-9) 2.36"), True, False),
        ((1, ""), (0, "ldd (GNU libc) 2.41"), True, False),
        ((1, ""), (1, "musl libc (x86_64)\nVersion 1.2.5"), False, True),
        (None, None, True, True),
        (None, None, False, False),
    ],
)
def test_musl_is_decided_as_install_sh_decides_it(
    monkeypatch: pytest.MonkeyPatch,
    getconf: tuple[int, str] | None,
    ldd: tuple[int, str] | None,
    loader: bool,
    expected: bool,
) -> None:
    monkeypatch.setattr(cli, "_command", commands({"getconf": getconf, "ldd": ldd}))
    found = [Path("/lib/ld-musl-x86_64.so.1")] if loader else []
    monkeypatch.setattr(cli.Path, "glob", lambda self, pattern: iter(found))
    assert cli.musl() is expected


def test_avx2_is_read_from_proc_cpuinfo(monkeypatch: pytest.MonkeyPatch) -> None:
    cpuinfo = {"text": "flags\t\t: fpu sse4_2 avx avx2 bmi2\n"}

    def read_text(self: Path) -> str:
        if cpuinfo["text"] is None:
            raise OSError(2, "No such file")
        return cpuinfo["text"]

    monkeypatch.setattr(cli.Path, "read_text", read_text)
    assert cli.avx2("linux")
    cpuinfo["text"] = "flags\t\t: fpu sse4_2 avx avx512f\n"
    assert not cli.avx2("linux")
    cpuinfo["text"] = None  # type: ignore[assignment]
    assert not cli.avx2("linux")


@pytest.mark.parametrize(
    ("system", "machine", "musl", "avx2", "expected"),
    [
        ("linux", "x86_64", False, True, "linux-x64"),
        ("linux", "aarch64", False, False, "linux-arm64"),
        ("linux", "x86_64", True, True, "linux-x64-musl"),
        ("linux", "aarch64", True, False, "linux-arm64-musl"),
        ("linux", "x86_64", False, False, "linux-x64-baseline"),
        ("linux", "x86_64", True, False, "linux-x64-musl-baseline"),
        ("darwin", "arm64", False, False, "darwin-arm64"),
        ("darwin", "x86_64", False, False, "darwin-x64"),
        ("win32", "AMD64", False, True, "windows-x64"),
        ("win32", "AMD64", False, False, "windows-x64-baseline"),
        ("win32", "ARM64", False, True, "windows-x64"),
    ],
)
def test_target(
    monkeypatch: pytest.MonkeyPatch,
    system: str,
    machine: str,
    musl: bool,
    avx2: bool,
    expected: str,
) -> None:
    monkeypatch.setattr(cli, "musl", lambda: musl)
    monkeypatch.setattr(cli, "avx2", lambda system: avx2)
    assert target(system, machine) == expected


@pytest.mark.parametrize(("system", "machine"), [("linux", "riscv64"), ("freebsd14", "amd64")])
def test_no_binary_for_other_platforms(system: str, machine: str) -> None:
    with pytest.raises(cli.ShimError, match="There's no reeval binary") as error:
        target(system, machine)
    assert error.value.code == 2


def venv(at: Path) -> Path:
    python = at / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    python.parent.mkdir(parents=True)
    python.write_text("")
    return python


def test_the_evals_run_on_the_projects_python(clean: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    assert cli.project_python() == sys.executable
    nested = clean / "project" / "evals"
    nested.mkdir(parents=True)
    project = venv(clean / "project" / ".venv")
    monkeypatch.chdir(nested)
    assert cli.project_python() == str(project)
    active = venv(clean / "elsewhere")
    monkeypatch.setenv("VIRTUAL_ENV", str(clean / "elsewhere"))
    assert cli.project_python() == str(active)
    monkeypatch.setenv("VIRTUAL_ENV", str(clean / "gone"))
    assert cli.project_python() == str(project)


@posix
def test_a_tool_install_runs_the_evals_on_the_projects_venv(tmp_path: Path) -> None:
    binary = tmp_path / "my-reeval"
    binary.write_text(FAKE)
    binary.chmod(0o755)
    project = venv(tmp_path / ".venv")
    result = reeval(tmp_path, "run", REEVAL_BINARY=str(binary))
    assert result.stdout.strip() == f"fake reeval run python={project}"


@pytest.mark.skipif(sys.platform == "win32", reason="sends SIGINT to a process group")
def test_ctrl_c_on_the_spawn_path_lets_reeval_finish_its_cleanup(tmp_path: Path) -> None:
    done = tmp_path / "done"
    child = tmp_path / "child.py"
    child.write_text(
        textwrap.dedent(f"""
            import signal, sys, time
            def stop(*_):
                time.sleep(1)
                open({str(done)!r}, "w").write("cleaned up")
                sys.exit(130)
            signal.signal(signal.SIGINT, stop)
            open({str(done)!r} + ".ready", "w").close()
            time.sleep(30)
        """)
    )
    launcher = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import sys; from reeval_python import cli;"
            f" sys.exit(cli.spawn([sys.executable, {str(child)!r}], {{}}))",
        ],
        start_new_session=True,
    )
    deadline = time.monotonic() + 20
    while not Path(f"{done}.ready").exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    os.killpg(launcher.pid, signal.SIGINT)
    assert launcher.wait(timeout=20) == 130
    assert done.read_text() == "cleaned up"


def test_spawn_passes_the_exit_code_through(tmp_path: Path) -> None:
    code = cli.spawn([sys.executable, "-c", "raise SystemExit(7)"], dict(os.environ))
    signal.signal(signal.SIGINT, signal.default_int_handler)
    assert code == 7


def test_binaries_json_is_read_only_for_its_own_version(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    manifest = {"version": "1.0.0", "binaries": {"linux-x64": {"sha256": "ab", "size": 2}}}
    path = tmp_path / "binaries.json"
    path.write_text(json.dumps(manifest))
    monkeypatch.setattr(cli, "__file__", str(path))
    assert cli.recorded("1.0.0", "linux-x64") == {"sha256": "ab", "size": 2}
    assert cli.recorded("1.0.1", "linux-x64") is None
    assert stat.S_ISREG(path.stat().st_mode)


def test_a_prerelease_sdk_runs_reevals_prerelease(
    clean: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(cli, "dist_version", lambda name: "1.0.0b1")
    assert cli.binary_version() == "1.0.0-beta.1"
    monkeypatch.setenv("REEVAL_OFFLINE", "1")
    with pytest.raises(cli.ShimError, match=r"reeval 1\.0\.0-beta\.1 isn't in the cache") as error:
        cli.resolve()
    assert f"bin/1.0.0-beta.1/reeval-1.0.0-beta.1-{target()}" in str(error.value).replace("\\", "/")
