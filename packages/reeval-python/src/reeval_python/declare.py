"""Build a declaration tree matching reeval's TypeScript collector ordering."""

from __future__ import annotations

import importlib.util
import inspect
import itertools
import re
import sys
from collections.abc import Callable, Coroutine, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Generic, TypeVar, cast, overload

from reeval_python import _wire as w
from reeval_python.checks import ASSERT_HOOK, check, compile_eval
from reeval_python.options import EvalOptions
from reeval_python.wire import options_to_wire

if TYPE_CHECKING:
    from reeval_python.context import AttemptContext, SyncAttemptContext

Mode = w.DeclaredMode


@dataclass
class DeclaredFamily:
    name: str
    case: int
    cases: int

    def as_json(self) -> w.DeclaredFamily:
        return {"name": self.name, "case": self.case, "cases": self.cases}


@dataclass
class DeclaredEval:
    name: str
    mode: Mode
    options: dict[str, Any]
    body: str
    family: DeclaredFamily | None = None

    def as_json(self) -> w.DeclaredEval:
        out: w.DeclaredEval = {
            "type": "eval",
            "name": self.name,
            "mode": self.mode,
            "options": cast(w.EvalOptionsData, self.options),
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

    def as_json(self) -> w.DeclaredGroup:
        return {
            "type": "group",
            "name": self.name,
            "mode": self.mode,
            "options": cast(w.EvalOptionsData, self.options),
            "children": [c.as_json() for c in self.children],
        }


@dataclass
class DeclaredTodo:
    name: str

    def as_json(self) -> w.DeclaredTodo:
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
_names: set[tuple[str, ...]] = set()


def reset_collector() -> None:
    global _tree_children, _group_stack, _suites, _bodies, _names
    _tree_children = []
    _group_stack = []
    _suites = [_Suite()]
    _bodies = {}
    _names = set()


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
    arg: Callable[[], None] | EvalOptions | None = None,
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


SyncBody = Callable[["SyncAttemptContext"], None]
AsyncBody = Callable[["AttemptContext"], Coroutine[Any, Any, None]]
# A body is a `def` taking the blocking context or an `async def` taking the awaiting one, and
# returns nothing: pyright refuses a mismatched context, a generator or a returned value.
Body = TypeVar("Body", SyncBody, AsyncBody)


@overload
def evaluate(
    name: str, options: EvalOptions | None = None, /, *, mode: Mode = "run"
) -> Callable[[Body], Body]: ...
@overload
def evaluate(name: str, fn: Body, /, *, mode: Mode = "run") -> Body: ...
@overload
def evaluate(name: str, options: EvalOptions, fn: Body, /, *, mode: Mode = "run") -> Body: ...


def evaluate(
    name: str,
    arg: Callable[..., Any] | EvalOptions | None = None,
    arg2: Callable[..., Any] | None = None,
    /,
    *,
    mode: Mode = "run",
) -> Any:
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


_PLACEHOLDER = re.compile(r"%#|%s|\$([A-Za-z_]\w*)")


def _case_name(template: str, case: Any, index: int) -> str:
    """A case's eval name: `%#` is its index, `%s` the case as `str()` writes it, and `$field`
    the field of a dict case (left as written when the case has no such field). One pass, so a
    value that contains a placeholder stays as it is."""
    fields = cast(dict[str, Any], case) if isinstance(case, dict) else {}

    def fill(m: re.Match[str]) -> str:
        if m.group(0) == "%#":
            return str(index)
        if m.group(0) == "%s":
            return str(cast(object, case))
        key = m.group(1)
        return str(fields[key]) if key in fields else m.group(0)

    return _PLACEHOLDER.sub(fill, template)


def is_async(fn: Callable[..., Any]) -> bool:
    """Whether a body is `async def`, under any decorators that keep `functools.wraps`."""
    if inspect.iscoroutinefunction(fn):
        return True
    try:
        return inspect.iscoroutinefunction(inspect.unwrap(fn))
    except ValueError:
        return False


def _refuse_generator(fn: Callable[..., Any], where: str) -> None:
    try:
        inner = inspect.unwrap(fn)
    except ValueError:
        inner = fn
    if inspect.isgeneratorfunction(inner) or inspect.isasyncgenfunction(inner):
        raise TypeError(
            f"{where}: an eval body can't yield, or it never runs: declare it def or async def "
            "without yield"
        )


def _with_case(fn: Callable[..., Any], case: Any) -> Callable[..., Any]:
    if is_async(fn):

        async def body_async(c: Any) -> Any:
            result = fn(c, case)
            return await result if inspect.isawaitable(result) else result

        return body_async

    def body(c: Any) -> Any:
        return fn(c, case)

    return body


T = TypeVar("T")
SyncCaseBody = Callable[["SyncAttemptContext", T], None]
AsyncCaseBody = Callable[["AttemptContext", T], Coroutine[Any, Any, None]]


class _Each(Generic[T]):
    """`evaluate_each(…)`'s decorator: a body taking the context and one case."""

    def __init__(self, register: Callable[[Callable[..., Any]], None]) -> None:
        self._register = register

    @overload
    def __call__(self, fn: SyncCaseBody[T], /) -> SyncCaseBody[T]: ...
    @overload
    def __call__(self, fn: AsyncCaseBody[T], /) -> AsyncCaseBody[T]: ...

    def __call__(self, fn: Callable[..., Any], /) -> Any:
        self._register(fn)
        return fn


def evaluate_each(
    cases: Sequence[T],
    name_template: str,
    options: EvalOptions | None = None,
    *,
    pool: bool = True,
) -> _Each[T]:
    """One eval per case; the body gets `(c, case)`. Its cases pool into one family unless
    `pool=False` or there's only one.

    Each eval is named from `name_template`: `%#` is the case's index, `%s` the case as `str()`
    writes it, and `$field` a dict case's field (`"greets $name"`), left as written when the
    case has no such field.
    """
    if not isinstance(cast(object, cases), list | tuple):
        raise TypeError(
            f"evaluate_each takes a list of cases (got {type(cases).__name__}), e.g. "
            'evaluate_each([{"n": 1}, {"n": 2}], "case $n")'
        )
    opts = dict[str, Any](options or {})
    hint = (
        f" For evaluate_each, put $key, %s or %# in the name ({name_template!r}) so each case's "
        "name differs."
    )

    def decorator(fn: Callable[..., Any]) -> None:
        _refuse_generator(fn, f"evaluate_each({name_template!r})")
        try:
            inspect.signature(fn).bind(None, None)
        except TypeError:
            raise TypeError(
                f"evaluate_each({name_template!r}): the body takes the attempt and its case, "
                "e.g. def body(c, case)"
            ) from None
        except ValueError:
            pass
        for index, case in enumerate(cases):
            family = None
            if pool and len(cases) > 1:
                family = DeclaredFamily(name=name_template, case=index, cases=len(cases))
            name = _case_name(name_template, case, index)
            _register_eval(name, "run", opts, _with_case(fn, case), family, hint)

    return _Each(decorator)


def todo(name: str) -> None:
    """An eval or group still to write: listed in the plan, never run."""
    _declare(DeclaredTodo(name=name))


def _register_eval(
    name: str,
    mode: Mode,
    options: dict[str, Any],
    fn: Callable[..., Any],
    family: DeclaredFamily | None,
    hint: str = "",
) -> None:
    path = (*(frame.name for frame in _group_stack), name)
    where = f"evaluate({' › '.join(path)!r})"
    _refuse_generator(fn, where)
    if path in _names:
        raise ValueError(
            f"{where} is declared twice in this file. Each eval needs its own name, or its "
            f"attempts are merged into one eval.{hint}"
        )
    _names.add(path)
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


def _tree_after_loader(loader: Callable[[], None]) -> w.DeclarationTree:
    reset_collector()
    loader()
    _collect_suite_sync(_suites[0])
    assert _tree_children is not None
    return {"children": [c.as_json() for c in _tree_children]}


def collect_module_tree_sync(loader: Callable[[], None]) -> w.DeclarationTree:
    return _tree_after_loader(loader)


def get_body(body_id: str) -> Callable[..., Any]:
    if body_id not in _bodies:
        raise KeyError(f"unknown eval body {body_id}")
    return _bodies[body_id]


_module_ids = itertools.count(1)


def collect_eval_file(path: Path) -> w.DeclarationTree:
    """Import one *.eval.py file and return its declaration tree JSON."""

    def loader() -> None:
        # dataclasses, typing.get_type_hints and pickle find a class's module in sys.modules,
        # so the file stays registered there, under a name no other file shares.
        name = f"reeval_eval_{next(_module_ids)}"
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None:
            raise ImportError(f"can't load {path}")
        module = importlib.util.module_from_spec(spec)
        module.__dict__[ASSERT_HOOK] = check
        source = importlib.util.decode_source(path.read_bytes())
        sys.modules[name] = module
        try:
            exec(compile_eval(source, str(path)), module.__dict__)  # noqa: S102
        except BaseException:
            sys.modules.pop(name, None)
            raise

    return collect_module_tree_sync(loader)
