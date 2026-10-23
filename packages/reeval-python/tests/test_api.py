"""The public API's data: options in reeval's spelling at any depth, the shapes evaluate_each
takes, environments that don't change under the eval, and plugin builds on every source."""

from __future__ import annotations

import gc
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from reeval_python import (
    AttemptContext,
    define_environment,
    docker,
    evaluate_each,
    fake_harness,
    plugin,
)
from reeval_python.declare import collect_module_tree_sync
from reeval_python.wire import options_to_wire


def test_reeval_keys_are_camel_cased_at_any_depth_and_record_keys_are_not() -> None:
    wire = options_to_wire(
        {
            "compare": {"min_lift": 0.1},
            "judge": {"provider_options": {"google": {"thinking_config": 1}}},
            "harness": fake_harness(delay_ms=5, fail_with="boom"),
            "sandbox": docker(start_timeout="1m", env={"MY_VAR": "x", "snake_key": "y"}),
            "not_a_reeval_key": 1,
        }
    )
    assert wire == {
        "compare": {"minLift": 0.1},
        "judge": {"providerOptions": {"google": {"thinking_config": 1}}},
        "harness": {"kind": "fake", "delayMs": 5, "failWith": "boom"},
        "sandbox": {
            "kind": "docker",
            "startTimeout": "1m",
            "env": {"MY_VAR": "x", "snake_key": "y"},
        },
        "not_a_reeval_key": 1,
    }


def test_an_environment_spec_is_camel_cased_and_copied() -> None:
    spec: dict[str, Any] = {"harness": {"kind": "fake", "delay_ms": 5}, "env": {"A": "1"}}
    env = define_environment("e", spec)
    spec["env"]["A"] = "changed"
    child = env.extend("child", spec)
    spec["env"]["A"] = "changed again"
    layers = child.to_wire()["layers"]
    assert layers[0]["spec"] == {"harness": {"kind": "fake", "delayMs": 5}, "env": {"A": "1"}}
    assert layers[1]["spec"]["env"] == {"A": "changed"}


def test_every_plugin_source_takes_a_build() -> None:
    sources = [
        plugin.local("plugins/lint", build="npm run build"),
        plugin.git("github:acme/lint", build=("npm ci", "npm run build")),
        plugin.npm("@acme/lint", build={"run": "make", "cwd": "src"}),
        plugin.marketplace("lint@github:acme/plugins", build=["make"]),
    ]
    assert [p["build"] for p in sources] == [
        "npm run build",
        ["npm ci", "npm run build"],
        {"run": "make", "cwd": "src"},
        ["make"],
    ]


@pytest.mark.parametrize("cases", ["abc", (c for c in "ab"), {"a": 1}])
def test_evaluate_each_takes_a_list_of_cases(cases: Any) -> None:
    with pytest.raises(TypeError, match="takes a list of cases"):
        evaluate_each(cases, "case %s")


def test_evaluate_each_refuses_a_body_without_the_case_where_it_is_declared() -> None:
    def load() -> None:
        @evaluate_each([1, 2], "case %s")
        def _(c: Any) -> None: ...

    with pytest.raises(TypeError, match=r"the body takes the attempt and its case"):
        collect_module_tree_sync(load)


def test_an_async_command_is_a_coroutine_that_warns_if_never_awaited() -> None:
    async def send(call: Any) -> dict[str, Any]:
        return {"ok": True}

    c = AttemptContext("k1", send)
    with pytest.warns(RuntimeWarning, match="was never awaited"):
        c.exec("npm install")
        gc.collect()


def test_expect_refuses_a_coroutine_and_poll_a_value() -> None:
    from reeval_python.context import describe
    from reeval_python.wire import subject_for_matcher

    async def send(call: Any) -> dict[str, Any]:
        return {"ok": True}

    c = AttemptContext("k1", send)
    with pytest.raises(TypeError, match="await it first"):
        subject_for_matcher(c.exec("true"))
    assert describe(lambda: c.read_file("a.txt")) == {"readFile": "a.txt"}
    assert describe(lambda: c.exec("npm test")) == {"exec": "npm test"}
    with pytest.raises(TypeError, match="must return c.read_file"):
        describe(lambda: "ready")
    with pytest.raises(TypeError, match="must return c.read_file"):
        describe(lambda: c.send("hi"))


USER_EVAL = """
from reeval_python import AttemptContext, evaluate


@evaluate("typed", {"timeout": "1s"})
async def typed(c: AttemptContext) -> None:
    flag = bool(len("x"))
    await c.exec("true", background=flag)


@evaluate("bare")
def bare(c) -> None: ...


reveal_type(typed)
"""


def test_a_user_eval_type_checks_under_strict_pyright(tmp_path: Path) -> None:
    pyright = shutil.which("pyright")
    if pyright is None:
        pytest.skip("pyright isn't on PATH")
    (tmp_path / "x.eval.py").write_text(USER_EVAL)
    src = str(Path(__file__).resolve().parents[1] / "src")
    config = {
        "typeCheckingMode": "strict",
        "extraPaths": [src],
        "reportUnknownParameterType": False,
    }
    config |= {"reportMissingParameterType": False, "reportUnknownArgumentType": False}
    (tmp_path / "pyrightconfig.json").write_text(json.dumps(config))
    out = subprocess.run(
        [pyright, "--outputjson", "--pythonpath", sys.executable],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=False,
    )
    report = json.loads(out.stdout)
    errors = [d["message"] for d in report["generalDiagnostics"] if d["severity"] == "error"]
    assert errors == []
    [revealed] = [
        d["message"] for d in report["generalDiagnostics"] if d["severity"] == "information"
    ]
    assert "Coroutine" in revealed, revealed


def test_case_names_fill_each_placeholder_once() -> None:
    from reeval_python.declare import _case_name  # pyright: ignore[reportPrivateUsage]

    assert _case_name("case %# is %s", "ada", 2) == "case 2 is ada"
    assert _case_name("$name and $names", {"name": "a", "names": "b"}, 0) == "a and b"
    assert _case_name("$name", {"name": "$other", "other": "x"}, 0) == "$other"
    assert _case_name("$missing %s", {"a": 1}, 0) == "$missing {'a': 1}"
    assert _case_name("%s", "100%#", 7) == "100%#"
