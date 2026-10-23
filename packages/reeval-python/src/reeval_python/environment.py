"""Environments, plugins, sandboxes and harnesses as eval options: data reeval checks when it
plans the run."""

from __future__ import annotations

import copy
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, NotRequired, TypedDict

from reeval_python.wire import value_to_wire

# The package registries and code hosts an install step needs, for an `egress` allow list
# that adds to them: `{"allow": [*DEFAULT_EGRESS_ALLOW, "api.example.com"]}`.
DEFAULT_EGRESS_ALLOW: tuple[str, ...] = (
    "registry.npmjs.org",
    "registry.yarnpkg.com",
    "github.com",
    "*.github.com",
    "*.githubusercontent.com",
    "pypi.org",
    "files.pythonhosted.org",
)


@dataclass(frozen=True)
class Environment:
    """A named environment: its own spec on top of the environments it extends. Each spec is a
    copy, so changing the dict passed in later doesn't change the environment."""

    name: str
    layers: tuple[tuple[str, dict[str, Any]], ...]

    def extend(self, name: str, spec: dict[str, Any]) -> Environment:
        """A child environment: its spec replaces this one's, key by key."""
        return Environment(name, (*self.layers, (name, copy.deepcopy(spec))))

    def to_wire(self) -> dict[str, Any]:
        layers = [{"name": n, "spec": value_to_wire(s)} for n, s in self.layers]
        return {"kind": "environment", "name": self.name, "layers": layers}


def define_environment(name: str, spec: dict[str, Any]) -> Environment:
    """An environment to run evals in: sandbox, files, setup, skills, plugins, egress, env."""
    return Environment(name, ((name, copy.deepcopy(spec)),))


def _present(**fields: Any) -> dict[str, Any]:
    return {k: v for k, v in fields.items() if v is not None}


class PluginBuild(TypedDict):
    """A plugin's build commands, run from `cwd` (relative to its source) instead of its
    directory."""

    run: str | list[str]
    cwd: NotRequired[str]


Build = str | Sequence[str] | PluginBuild


def _build(build: Build | None) -> dict[str, Any]:
    """`build=` as reeval's data: a command, commands in order, or `{"run": …, "cwd": …}`."""
    if build is None:
        return {}
    if isinstance(build, str) or isinstance(build, dict):
        return {"build": build}
    return {"build": list(build)}


class _Plugins:
    """Agent plugins an environment installs: `plugin.git(...)`, `plugin.npm(...)`, …"""

    def local(
        self, path: str, *, only: list[str] | None = None, build: Build | None = None
    ) -> dict[str, Any]:
        fields = {**_present(only=only), **_build(build)}
        return {"kind": "plugin", "source": "local", "path": path, **fields}

    def git(
        self,
        repo: str,
        *,
        ref: str | None = None,
        path: str | None = None,
        only: list[str] | None = None,
        build: Build | None = None,
    ) -> dict[str, Any]:
        fields = {**_present(ref=ref, path=path, only=only), **_build(build)}
        return {"kind": "plugin", "source": "git", "repo": repo, **fields}

    def npm(
        self,
        spec: str,
        *,
        path: str | None = None,
        only: list[str] | None = None,
        build: Build | None = None,
    ) -> dict[str, Any]:
        fields = {**_present(path=path, only=only), **_build(build)}
        return {"kind": "plugin", "source": "npm", "spec": spec, **fields}

    def marketplace(
        self,
        entry: str,
        *,
        ref: str | None = None,
        only: list[str] | None = None,
        build: Build | None = None,
    ) -> dict[str, Any]:
        """`name@source`: an entry of a git marketplace, or of an `npm:<package>` one."""
        name, at, source = entry.partition("@")
        if not name or not at or not source.strip():
            raise ValueError(
                "plugin.marketplace() needs 'name@source', e.g. "
                f"plugin.marketplace('lint@github:acme/agent-plugins') (got {entry!r})"
            )
        source = source.strip()
        if source.startswith("npm:"):
            if ref is not None:
                raise ValueError(
                    f"plugin.marketplace({entry!r}): ref picks a commit of a git marketplace; "
                    "pin an npm marketplace in its spec, e.g. npm:@acme/plugins@2.0.0"
                )
            market = {"source": "npm", "spec": source.removeprefix("npm:")}
        else:
            market = {"source": "git", "repo": source, **_present(ref=ref)}
        fields = {**_present(only=only), **_build(build)}
        return {
            "kind": "plugin",
            "source": "marketplace",
            "name": name,
            "marketplace": market,
            **fields,
        }


plugin = _Plugins()


def docker(*, from_: str | None = None, **options: Any) -> dict[str, Any]:
    """reeval's Docker sandbox, on another image (`from_`), Dockerfile or install layer."""
    return {"kind": "docker", **_present(**{"from": from_}), **value_to_wire(options)}


def fake_harness(**options: Any) -> dict[str, Any]:
    """The fake agent, for evals that run without a real one."""
    return {"kind": "fake", **value_to_wire(options)}


def fake_judge(**options: Any) -> dict[str, Any]:
    """A judge with a fixed `score`, for evals that run without a model."""
    return {"kind": "fake-judge", **value_to_wire(options)}
