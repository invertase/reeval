"""Build a declaration tree matching reeval's TypeScript collector ordering."""

from __future__ import annotations

import importlib.util
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, cast

from reeval_python.checks import ASSERT_HOOK, check, compile_eval
from reeval_python.wire import options_to_wire

Mode = Literal["run", "skip", "only", "todo"]


@dataclass
class DeclaredFamily:
    name: str
    case: int
    cases: int

    def as_json(self) -> dict[str, Any]:
        return {"name": self.name, "case": self.case, "cases": self.cases}


@dataclass
class DeclaredEval:
    name: str
    mode: Mode
    options: dict[str, Any]
    body: str
    family: DeclaredFamily | None = None

    def as_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "type": "eval",
            "name": self.name,
            "mode": self.mode,
            "options": self.options,
            "body": self.body,
        }
        if self.family is not None:
            out["family"] = self.family.as_json()
        return out


@dataclass
class DeclaredGroup:
    name: str
    mode: Mode
    options: dict[str, Any]
    children: list[DeclNode] = field(default_factory=list)  # pyright: ignore[reportUnknownVariableType]

    def as_json(self) -> dict[str, Any]:
        return {
            "type": "group",
            "name": self.name,
            "mode": self.mode,
            "options": self.options,
            "children": [c.as_json() for c in self.children],
        }


@dataclass
class DeclaredTodo:
    name: str

    def as_json(self) -> dict[str, Any]:
        return {"type": "todo", "name": self.name}


DeclNode = DeclaredEval | DeclaredGroup | DeclaredTodo


@dataclass
class _GroupFrame:
    name: str
    options: dict[str, Any]
    node: DeclaredGroup


def _empty_suites() -> list[_Suite]:
    return []


@dataclass
class _Suite:
    factory: Callable[[], None] | None = None
    suites: list[_Suite] = field(default_factory=_empty_suites)


_tree_children: list[DeclNode] | None = None
_group_stack: list[_GroupFrame] = []
_suites: list[_Suite] = []
_bodies: dict[str, Callable[..., Any]] = {}


def reset_collector() -> None:
    global _tree_children, _group_stack, _suites, _bodies
    _tree_children = []
    _group_stack = []
    _suites = [_Suite()]
    _bodies = {}


def _next_body(fn: Callable[..., Any]) -> str:
    body = f"b{len(_bodies) + 1}"
    _bodies[body] = fn
    return body


def _declare(node: DeclNode) -> None:
    parent = _group_stack[-1].node if _group_stack else None
    if parent is not None:
        parent.children.append(node)
    else:
        assert _tree_children is not None
        _tree_children.append(node)


def _register_group(
    name: str, mode: Mode, options: dict[str, Any], factory: Callable[[], None]
) -> None:
    suite = _Suite(factory=factory)
    _suites[-1].suites.append(suite)


def _wire_options(options: dict[str, Any]) -> dict[str, Any]:
    return options_to_wire(options) or {}


def group(
    name: str,
    arg: Callable[[], None] | dict[str, Any] | None = None,
    arg2: Callable[[], None] | None = None,
    /,
    *,
    mode: Mode = "run",
) -> None:
    if callable(arg) and arg2 is None:
        fn, opts = arg, {}
    elif isinstance(arg, dict) and callable(arg2):
        opts, fn = dict[str, Any](cast(dict[str, Any], arg)), arg2
    else:
        raise TypeError("group(name, options, fn) or group(name, fn)")

    node = DeclaredGroup(name=name, mode=mode, options=_wire_options(opts), children=[])
    _declare(node)
    frame = _GroupFrame(name=name, options=opts, node=node)

    def factory() -> None:
        outer = _group_stack.copy()
        _group_stack.clear()
        _group_stack.extend([*outer, frame])
        try:
            fn()
        finally:
            _group_stack.clear()
            _group_stack.extend(outer)

    _register_group(name, mode, opts, factory)


def evaluate(
    name: str,
    arg: Callable[..., Any] | dict[str, Any] | None = None,
    arg2: Callable[..., Any] | None = None,
    /,
    *,
    mode: Mode = "run",
) -> Callable[[Callable[..., Any]], Callable[..., Any]] | None:
    if callable(arg) and arg2 is None:
        _register_eval(name, mode, {}, arg, None)
        return arg
    if isinstance(arg, dict) and callable(arg2):
        _register_eval(name, mode, dict[str, Any](cast(dict[str, Any], arg)), arg2, None)
        return arg2

    opts = dict[str, Any](cast(dict[str, Any], arg)) if isinstance(arg, dict) else {}

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        _register_eval(name, mode, opts, fn, None)
        return fn

    return decorator


def evaluate_each(cases: Sequence[Any], name_template: str, options: dict[str, Any] | None = None):
    opts = dict[str, Any](options or {})

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        for index, case in enumerate(cases):
            family = DeclaredFamily(name=name_template, case=index, cases=len(cases))
            case_value: Any = case
            if isinstance(case_value, dict) and "n" in case_value:
                display = name_template.replace("$n", str(cast(Any, case_value["n"])))
            else:
                display = name_template.replace("$n", str(index + 1)).replace("%#", str(index))
            _register_eval(display, "run", opts, fn, family)
        return fn

    return decorator


def _register_eval(
    name: str,
    mode: Mode,
    options: dict[str, Any],
    fn: Callable[..., Any],
    family: DeclaredFamily | None,
) -> None:
    body = _next_body(fn)
    _declare(
        DeclaredEval(
            name=name,
            mode=mode,
            options=_wire_options(options),
            body=body,
            family=family,
        )
    )


def _collect_suite_sync(suite: _Suite) -> None:
    if suite.factory is not None:
        suite.factory()
    for nested in suite.suites:
        _collect_suite_sync(nested)


def _tree_after_loader(loader: Callable[[], None]) -> dict[str, Any]:
    reset_collector()
    loader()
    _collect_suite_sync(_suites[0])
    assert _tree_children is not None
    return {"children": [c.as_json() for c in _tree_children]}


async def collect_module_tree(loader: Callable[[], None]) -> dict[str, Any]:
    return _tree_after_loader(loader)


def collect_module_tree_sync(loader: Callable[[], None]) -> dict[str, Any]:
    return _tree_after_loader(loader)


def get_body(body_id: str) -> Callable[..., Any]:
    if body_id not in _bodies:
        raise KeyError(f"unknown eval body {body_id}")
    return _bodies[body_id]


def collect_eval_file(path: Path) -> dict[str, Any]:
    """Import one *.eval.py file and return its declaration tree JSON."""

    def loader() -> None:
        spec = importlib.util.spec_from_file_location("reeval_eval", path)
        if spec is None:
            raise ImportError(f"can't load {path}")
        module = importlib.util.module_from_spec(spec)
        module.__dict__[ASSERT_HOOK] = check
        source = importlib.util.decode_source(path.read_bytes())
        exec(compile_eval(source, str(path)), module.__dict__)  # noqa: S102

    return collect_module_tree_sync(loader)
