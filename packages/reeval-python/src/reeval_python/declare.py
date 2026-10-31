"""Build a declaration tree matching reeval's TypeScript collector ordering."""

from __future__ import annotations

import ast
import dataclasses
import functools
import hashlib
import importlib.util
import inspect
import itertools
import json
import linecache
import math
import re
import sys
import textwrap
from collections.abc import Callable, Coroutine, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Generic, TypeVar, cast, overload

from reeval_python import _wire as w
from reeval_python.checks import ASSERT_HOOK, check, compile_eval
from reeval_python.environment import Environment
from reeval_python.options import CaseOptions, EvalOptions
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
    source: w.DeclaredSource
    family: DeclaredFamily | None = None

    def as_json(self) -> w.DeclaredEval:
        out: w.DeclaredEval = {
            "type": "eval",
            "name": self.name,
            "mode": self.mode,
            "options": cast(w.EvalOptionsData, self.options),
            "body": self.body,
            "source": self.source,
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
# By id (the names joined with " › "): each eval's name path and whether it is a family's case.
_names: dict[str, tuple[tuple[str, ...], bool]] = {}
# Each eval with cases: its name path, by its id.
_families: dict[str, tuple[str, ...]] = {}


def reset_collector() -> None:
    global _tree_children, _group_stack, _suites, _bodies, _names, _families
    _tree_children = []
    _group_stack = []
    _suites = [_Suite()]
    _bodies = {}
    _names = {}
    _families = {}


def _separator_hint(path: tuple[str, ...], earlier: tuple[str, ...]) -> str:
    """Two name paths with one id differ only where a name holds the " › " joining them."""
    if len(path) == len(earlier):
        return ""
    return (
        """ " › " joins the group and eval names in an eval's id, so a name containing it can be """
        "a grouped eval's id."
    )


def _named_like_family(path: tuple[str, ...], family: tuple[str, ...]) -> ValueError:
    return ValueError(
        f"evaluate({' › '.join(path)!r}) has the same id as "
        f"evaluate({' › '.join(family)!r}) with cases in this file. Give one of them another "
        f"name.{_separator_hint(path, family)}"
    )


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


T = TypeVar("T")
SyncCaseBody = Callable[["SyncAttemptContext", T], None]
AsyncCaseBody = Callable[["AttemptContext", T], Coroutine[Any, Any, None]]


class _Cases(Generic[T]):
    """`evaluate(name, {"cases": …})`'s decorator: a body taking the context and one case."""

    def __init__(self, register: Callable[[Callable[..., Any]], None]) -> None:
        self._register = register

    @overload
    def __call__(self, fn: SyncCaseBody[T], /) -> SyncCaseBody[T]: ...
    @overload
    def __call__(self, fn: AsyncCaseBody[T], /) -> AsyncCaseBody[T]: ...

    def __call__(self, fn: Callable[..., Any], /) -> Any:
        self._register(fn)
        return fn


# Overlaps the next on purpose: options with `cases` are `EvalOptions` too, and take a case body.
@overload
def evaluate(  # pyright: ignore[reportOverlappingOverload]
    name: str, options: CaseOptions[T], /, *, mode: Mode = "run"
) -> _Cases[T]: ...
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
    arg: Callable[..., Any] | EvalOptions | CaseOptions[Any] | None = None,
    arg2: Callable[..., Any] | None = None,
    /,
    *,
    mode: Mode = "run",
) -> Any:
    """An eval: its name, options and body. With `cases`, the body takes `(c, case)` and runs
    once per case with every cell and run."""
    if callable(arg) and arg2 is None:
        _register_eval(name, mode, {}, arg, None, None)
        return arg
    opts = dict[str, Any](cast(dict[str, Any], arg)) if isinstance(arg, dict) else {}
    with_cases = "cases" in opts or "case_key" in opts
    if callable(arg2):
        if with_cases:
            _register_cases(name, mode, opts, arg2)
        else:
            _register_eval(name, mode, opts, arg2, None, None)
        return arg2

    if with_cases:
        return _Cases[Any](lambda fn: _register_cases(name, mode, opts, fn))

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        _register_eval(name, mode, opts, fn, None, None)
        return fn

    return decorator


_BAD_KEY = re.compile(r"[#/›\x00-\x1f\x7f]")
CASE_KEY_MAX = 80


def _default_key(case: Any) -> str | None:
    if isinstance(case, str):
        return case
    if isinstance(case, int | float) and not isinstance(case, bool) and math.isfinite(case):
        return _js_number(case)
    if isinstance(case, dict):
        fields = cast(dict[str, Any], case)
        for key in ("id", "name"):
            if isinstance(fields.get(key), str):
                return cast(str, fields[key])
    for key in ("id", "name"):
        value = getattr(cast(object, case), key, None)
        if isinstance(value, str):
            return value
    return None


def _js_number(n: float) -> str:
    """A number as JavaScript's `String(n)` writes it, so both SDKs key `2.0` as `2`."""
    return str(int(n)) if float(n).is_integer() and abs(n) < 1e21 else repr(float(n))


def case_keys(cases: Sequence[Any], case_key: Callable[[Any], Any] | None, where: str) -> list[str]:
    """Each case's key, in list order: `case_key(case)` when given, else its default. Trimmed,
    1–80 characters, with no `#`, `/`, `›` or control characters, and unique within the eval."""
    seen: dict[str, int] = {}
    out: list[str] = []
    for i, case in enumerate(cases):
        raw = case_key(case) if case_key else _default_key(case)
        if raw is None:
            raise ValueError(
                f"cases[{i}] in {where} has no key: a case is its own key when it's a string or "
                "a number, or a dict's id or name. Give it an id, or pass "
                '"case_key": lambda case: case["slug"].'
            )
        if not isinstance(raw, str):
            raise TypeError(
                f"case_key in {where} must return a string (got {raw!r} for cases[{i}])"
            )
        key = raw.strip()
        if not key or len(key) > CASE_KEY_MAX or _BAD_KEY.search(key):
            raise ValueError(
                f"cases[{i}] in {where} has the key {raw!r}: a case key is 1–{CASE_KEY_MAX} "
                "characters, with no #, /, › or control characters."
                + ("" if case_key else " Pass case_key to give it another.")
            )
        if key in seen:
            raise ValueError(
                f"cases[{seen[key]}] and cases[{i}] in {where} have the same key {key!r}. Each "
                "case needs its own key"
                + ("." if case_key else ": give them distinct ids or names, or pass case_key.")
            )
        seen[key] = i
        out.append(key)
    return out


def _register_cases(name: str, mode: Mode, opts: dict[str, Any], fn: Callable[..., Any]) -> None:
    """Each case plans as a member of a pooled family named for the eval, `<name> [<key>]`."""
    where = f"evaluate({name!r})"
    cases = opts.pop("cases", None)
    case_key = opts.pop("case_key", None)
    if not isinstance(cast(object, cases), list | tuple):
        raise TypeError(
            f"case_key in {where} names each case, but there are no cases. Add cases, or drop "
            "case_key."
            if cases is None
            else f"cases in {where} must be a list (got {type(cases).__name__}), e.g. "
            '"cases": ["users", "posts"]'
        )
    cases = cast(Sequence[Any], cases)
    if not cases:
        raise ValueError(f"cases in {where} is an empty list. Give at least one case.")
    if case_key is not None and not callable(case_key):
        raise TypeError(f"case_key in {where} must be a function from a case to its key")
    if isinstance(opts.get("runs"), dict):
        raise ValueError(
            f"{where} has cases, so it can't take runs={{'best_of': …}}: best-of stops each cell "
            "on its own, and the cases pool over the runs. Set a fixed count, e.g. runs=3."
        )
    _refuse_generator(fn, where)
    try:
        inspect.signature(fn).bind(None, None)
    except TypeError:
        raise TypeError(
            f"{where}: with cases, the body takes the attempt and its case, e.g. def body(c, case)"
        ) from None
    except ValueError:
        pass
    keys = case_keys(cases, cast(Callable[[Any], Any] | None, case_key), where)
    body = body_hash(fn, where)
    pooled = len(cases) > 1
    if pooled:
        path = (*(frame.name for frame in _group_stack), name)
        key = " › ".join(path)
        if key in _families:
            raise ValueError(
                f"{where} with cases is declared twice in this file. Each eval needs its own "
                "name, or their cases are pooled into one. Give each its own name."
                f"{_separator_hint(path, _families[key])}"
            )
        plain = _names.get(key)
        if plain is not None and not plain[1]:
            raise _named_like_family(plain[0], path)
        _families[key] = path
    for index, (case, case_name) in enumerate(zip(cases, keys, strict=True)):
        family = DeclaredFamily(name=name, case=index, cases=len(cases)) if pooled else None
        source: w.DeclaredSource = {
            "body": body,
            "case": case_hash(case, f"{where} case {case_name!r}"),
        }
        _register_eval(f"{name} [{case_name}]", mode, opts, _with_case(fn, case), source, family)


def body_hash(fn: Callable[..., Any], where: str) -> str:
    """sha256 of a body's source text, from `def` on: decorators (`@evaluate(…)` among them) are
    left out, a bound method is its function, and a decorator that keeps `functools.wraps` is
    looked through. A lambda is its own text, not its line's. Functions the body closes over
    (what a decorator without `functools.wraps` wrapped) are hashed with it. Raises when there's
    no source to read, rather than fingerprint less."""
    target: Any = getattr(fn, "__func__", fn)
    try:
        target = inspect.unwrap(target)
    except ValueError:
        pass
    if isinstance(target, functools.partial):
        raise TypeError(
            f"{where}: the body is a functools.partial, whose source reeval can't read to "
            "fingerprint the eval. Write a def that calls it, and bump revision when what it "
            "calls changes"
        )
    try:
        text = _source(target)
    except (OSError, TypeError) as exc:
        raise TypeError(
            f"{where}: reeval can't read the body's source to fingerprint the eval ({exc}). "
            "Declare it with def or async def in the .eval.py file: a body made by exec, typed "
            "at a REPL or a callable object has none"
        ) from None
    seen = {id(target)}
    for captured in _captured(target, seen):
        try:
            text += "\n" + _source(captured)
        except (OSError, TypeError):
            continue
    return hashlib.sha256(text.encode()).hexdigest()


def _source(fn: Any) -> str:
    if getattr(fn, "__name__", None) == "<lambda>":
        own = _lambda_source(fn)
        if own is not None:
            return own
    text = textwrap.dedent(inspect.getsource(fn))
    try:
        node = ast.parse(text).body[0]
    except (SyntaxError, IndexError):
        node = None
    if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
        text = "".join(text.splitlines(keepends=True)[node.lineno - 1 :])
    return text


def _lambda_source(fn: Any) -> str | None:
    """A lambda's own text: `inspect.getsource` gives its whole line, which may hold others. The
    lambda is the innermost one around every position its code reports."""
    code = fn.__code__
    spans = [
        ((line, col), (end_line, end_col))
        for line, end_line, col, end_col in code.co_positions()
        if line
        and end_line
        and col is not None
        and end_col is not None
        and (end_line, end_col) > (line, col)
    ]
    linecache.checkcache(code.co_filename)
    lines = linecache.getlines(code.co_filename)
    if not spans or not lines:
        return None
    source = "".join(lines)
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return None
    first = min(start for start, _ in spans)
    last = max(end for _, end in spans)
    around = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Lambda)
        and node.end_lineno is not None
        and node.end_col_offset is not None
        and (node.lineno, node.col_offset) <= first
        and last <= (node.end_lineno, node.end_col_offset)
    ]
    if not around:
        return None
    innermost = max(around, key=lambda node: (node.lineno, node.col_offset))
    return ast.get_source_segment(source, innermost)


def _captured(fn: Any, seen: set[int]) -> list[Any]:
    """The functions `fn` closes over, and theirs, each once."""
    out: list[Any] = []
    for cell in getattr(fn, "__closure__", None) or ():
        try:
            value = cell.cell_contents
        except ValueError:
            continue
        value = getattr(value, "__func__", value)
        if inspect.isfunction(value) and id(value) not in seen:
            seen.add(id(value))
            out.append(value)
            out.extend(_captured(value, seen))
    return out


def _case_default(value: Any) -> Any:
    if isinstance(value, Environment):
        return {"environment": value.name}
    to_wire = getattr(value, "_to_wire", None)
    if callable(to_wire):
        return to_wire()
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return dataclasses.asdict(value)
    raise TypeError(f"{type(value).__name__} isn't JSON data")


def case_hash(case: Any, where: str) -> str:
    """sha256 of a case's data as canonical JSON: keys sorted, no whitespace. A dataclass is its
    fields and an environment its name; anything else that isn't JSON is refused."""
    try:
        text = json.dumps(
            case,
            default=_case_default,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise TypeError(
            f"{where}: reeval fingerprints each case as JSON data, and this one isn't ({exc}). "
            "Pass dicts, lists, strings, numbers, booleans, None or dataclasses"
        ) from None
    return hashlib.sha256(text.encode()).hexdigest()


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


def todo(name: str) -> None:
    """An eval or group still to write: listed in the plan, never run."""
    _declare(DeclaredTodo(name=name))


def _register_eval(
    name: str,
    mode: Mode,
    options: dict[str, Any],
    fn: Callable[..., Any],
    source: w.DeclaredSource | None,
    family: DeclaredFamily | None,
    hint: str = "",
) -> None:
    path = (*(frame.name for frame in _group_stack), name)
    where = f"evaluate({' › '.join(path)!r})"
    _refuse_generator(fn, where)
    if source is None:
        source = {"body": body_hash(fn, where)}
    key = " › ".join(path)
    earlier = _names.get(key)
    if earlier is not None:
        raise ValueError(
            f"{where} is declared twice in this file. Each eval needs its own name, or its "
            f"attempts are merged into one eval.{hint}{_separator_hint(path, earlier[0])}"
        )
    if family is None and key in _families:
        raise _named_like_family(path, _families[key])
    _names[key] = (path, family is not None)
    body = _next_body(fn)
    _declare(
        DeclaredEval(
            name=name,
            mode=mode,
            options=_wire_options(options),
            body=body,
            source=source,
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
