"""Build a declaration tree matching reeval's TypeScript collector ordering."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

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
    children: list[DeclaredEval | DeclaredGroup | DeclaredTodo] = field(default_factory=list)

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


@dataclass
class _Suite:
    factory: Callable[[], None] | None = None
    suites: list[_Suite] = field(default_factory=list)


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


def _register_group(name: str, mode: Mode, options: dict[str, Any], factory: Callable[[], None]) -> None:
    suite = _Suite(factory=factory)
    _suites[-1].suites.append(suite)


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
        opts, fn = dict(arg), arg2
    else:
        raise TypeError("group(name, options, fn) or group(name, fn)")

    node = DeclaredGroup(name=name, mode=mode, options=opts, children=[])
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
        _register_eval(name, mode, dict(arg), arg2, None)
        return arg2

    opts = dict(arg if isinstance(arg, dict) else {})

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        _register_eval(name, mode, opts, fn, None)
        return fn

    return decorator


def evaluate_each(cases: Sequence[Any], name_template: str, options: dict[str, Any] | None = None):
    opts = dict(options or {})

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        for index, case in enumerate(cases):
            family = DeclaredFamily(name=name_template, case=index, cases=len(cases))
            if isinstance(case, dict) and "n" in case:
                display = name_template.replace("$n", str(case["n"]))
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
    _declare(DeclaredEval(name=name, mode=mode, options=options, body=body, family=family))


async def _collect_suite(suite: _Suite) -> None:
    if suite.factory is not None:
        suite.factory()
    for nested in suite.suites:
        await _collect_suite(nested)


async def collect_module_tree(loader: Callable[[], None]) -> dict[str, Any]:
    reset_collector()
    loader()
    await _collect_suite(_suites[0])
    assert _tree_children is not None
    return {"children": [c.as_json() for c in _tree_children]}


def collect_module_tree_sync(loader: Callable[[], None]) -> dict[str, Any]:
    import asyncio

    return asyncio.run(collect_module_tree(loader))


def get_body(body_id: str) -> Callable[..., Any]:
    if body_id not in _bodies:
        raise KeyError(f"unknown eval body {body_id}")
    return _bodies[body_id]
