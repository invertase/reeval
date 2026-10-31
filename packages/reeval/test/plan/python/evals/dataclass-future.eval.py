from __future__ import annotations

from dataclasses import dataclass

from reeval_python.declare import evaluate


@dataclass
class Case:
    name: str


@evaluate("case", {"cases": [Case("a"), Case("b")]})
async def each(c, case: Case):
    await c.send(case.name)
