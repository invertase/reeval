from reeval_python import evaluate, evaluate_each, group


def versioned():
    @evaluate("inherits")
    def inherits(c): ...

    @evaluate("overrides", {"revision": "v3"})
    def overrides(c): ...


group("versioned", {"revision": 2}, versioned)


@evaluate("unversioned")
def unversioned(c): ...


@evaluate_each([{"n": 1}, {"n": 2}], "case $n", {"revision": 1})
def case(c, case): ...
