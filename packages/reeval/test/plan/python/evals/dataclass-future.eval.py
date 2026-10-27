from __future__ import annotations

from dataclasses import dataclass

from reeval_python.declare import evaluate_each


@dataclass
class Case:
    name: str


@evaluate_each([Case("a"), Case("b")], "case %#")
async def each(c, case: Case):
    await c.send(case.name)
