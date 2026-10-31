from reeval_python import evaluate, group


def versioned():
    @evaluate("inherits")
    def inherits(c): ...

    @evaluate("overrides", {"revision": "v3"})
    def overrides(c): ...


group("versioned", {"revision": 2, "runs": 2, "timeout": 120}, versioned)


@evaluate("unversioned")
def unversioned(c): ...


@evaluate("case", {"cases": [1, 2], "revision": 1})
def case(c, case): ...
