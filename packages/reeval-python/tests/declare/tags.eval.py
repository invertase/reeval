from reeval_python import evaluate, evaluate_each, group


def slow_things():
    @evaluate("big")
    def big(c): ...

    @evaluate("bigger", {"tags": ["flaky"]})
    def bigger(c): ...


group("slow things", {"tags": ["slow"]}, slow_things)


@evaluate("quick")
def quick(c): ...


@evaluate_each([{"n": 1}, {"n": 2}], "case $n", {"tags": ["slow"]})
def case(c, case): ...
