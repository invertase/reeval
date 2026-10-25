"""The public API's data: options in reeval's spelling at any depth, the shapes evaluate_each
takes, environments that don't change under the eval, and plugin builds on every source."""

from __future__ import annotations

import gc
import json
import shutil
import subprocess
import sys
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

from reeval_python import (
    AttemptContext,
    define_environment,
    docker,
    evaluate,
    evaluate_each,
    fake_harness,
    group,
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
            "sandbox": docker(start_timeout=60, env={"MY_VAR": "x", "snake_key": "y"}),
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


@pytest.mark.parametrize(
    ("given", "wire"),
    [
        (90, "90s"),
        (1.5, "1500ms"),
        (0.25, "250ms"),
        (timedelta(minutes=5), "5m"),
        (timedelta(hours=2), "2h"),
        (timedelta(milliseconds=1.5), "1.5ms"),
    ],
)
def test_a_duration_is_seconds_or_a_timedelta(given: Any, wire: str) -> None:
    assert options_to_wire({"timeout": given}) == {"timeout": wire}
    sandbox = options_to_wire({"sandbox": docker(start_timeout=given)})
    assert sandbox == {"sandbox": {"kind": "docker", "startTimeout": wire}}


@pytest.mark.parametrize("given", ["1s", True, None, float("nan"), float("inf")])
def test_a_duration_refuses_anything_but_seconds(given: Any) -> None:
    with pytest.raises(TypeError, match="timeout takes seconds or a timedelta"):
        options_to_wire({"timeout": given})


def test_an_environment_spec_is_camel_cased_and_copied() -> None:
    spec: dict[str, Any] = {"harness": {"kind": "fake", "delay_ms": 5}, "env": {"A": "1"}}
    env = define_environment("e", spec)
    spec["env"]["A"] = "changed"
    child = env.extend("child", spec)
    spec["env"]["A"] = "changed again"
    layers = child._to_wire()["layers"]  # pyright: ignore[reportPrivateUsage]
    assert layers[0]["spec"] == {"harness": {"kind": "fake", "delayMs": 5}, "env": {"A": "1"}}
    assert layers[1]["spec"]["env"] == {"A": "changed"}


def test_every_plugin_source_takes_a_build() -> None:
    sources = [
        plugin.local("plugins/lint", build="npm run build"),
        plugin.git("github:acme/lint", build=("npm ci", "npm run build")),
        plugin.npm("@acme/lint", build={"run": "make", "cwd": "src"}),
        plugin.marketplace("lint@github:acme/plugins", build=["make"]),
    ]
    assert repr(sources[0]) == "Plugin(source='local', path='plugins/lint', build='npm run build')"
    assert [p._to_wire()["build"] for p in sources] == [  # pyright: ignore[reportPrivateUsage]
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
    with pytest.raises(TypeError, match="not c.send"):
        describe(lambda: c.send("hi"))


def test_poll_s_function_names_one_read_and_says_what_to_do_with_more() -> None:
    from reeval_python.context import describe

    async def send(call: Any) -> dict[str, Any]:
        return {"ok": True}

    c = AttemptContext("k1", send)
    with pytest.raises(TypeError, match=r"check its contents or output with a matcher.*\.stdout"):
        describe(lambda: c.exec("cat x").stdout)  # pyright: ignore[reportAttributeAccessIssue]
    with pytest.raises(TypeError, match="check its contents or output with a matcher"):
        describe(lambda: c.read_file("a") or c.read_file("b"))
    with pytest.raises(TypeError, match="check its contents or output with a matcher"):
        describe(lambda: c.read_file("a") == "x")
    with pytest.raises(TypeError, match="this one made 2"):
        describe(lambda: (c.read_file("a"), c.read_file("b")))
    with pytest.raises(TypeError, match="takes no arguments"):
        describe(c.read_file)  # pyright: ignore[reportArgumentType]


def test_a_case_name_declared_twice_says_how_to_tell_cases_apart() -> None:
    def load() -> None:
        @evaluate_each([1, 2], "same", pool=False)
        def _(c: Any, case: int) -> None: ...

    with pytest.raises(ValueError, match=r"is declared twice.*put \$key, %s or %# in the name"):
        collect_module_tree_sync(load)


def test_an_eval_declared_twice_is_refused_where_it_is_declared() -> None:
    def load() -> None:
        def body(c: Any) -> None: ...

        evaluate("a", body)
        group("g", lambda: evaluate("a", body))
        evaluate("a", body)

    with pytest.raises(ValueError, match=r"evaluate\('a'\) is declared twice") as raised:
        collect_module_tree_sync(load)
    assert "evaluate_each" not in str(raised.value)


@pytest.mark.parametrize("kind", ["def", "async def"])
def test_a_generator_body_is_refused_where_it_is_declared(kind: str) -> None:
    source = f"{kind} body(c):\n    yield\n"
    space: dict[str, Any] = {}
    exec(source, space)  # noqa: S102

    with pytest.raises(TypeError, match="an eval body can't yield"):
        collect_module_tree_sync(lambda: evaluate("g", space["body"]))
    with pytest.raises(TypeError, match="an eval body can't yield"):
        collect_module_tree_sync(lambda: evaluate_each([1], "g %s")(space["body"]))


USER_EVAL = """
from reeval_python import AttemptContext, evaluate


@evaluate("typed", {"timeout": 1})
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
