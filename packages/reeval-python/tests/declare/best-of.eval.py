from reeval_python import evaluate, group


@evaluate("best of 3", {"runs": {"best_of": 3}})
def best_of_3(c): ...


@evaluate("best of 5 over a gate", {"runs": {"best_of": 5}, "gate": "all"})
def best_of_5(c): ...


def best_of_3_for_the_group():
    @evaluate("inherits it")
    def inherits(c): ...

    @evaluate("a fixed count of its own", {"runs": 2})
    def fixed_count(c): ...


group("best of 3 for the group", {"runs": {"best_of": 3}}, best_of_3_for_the_group)


@evaluate("fixed")
def fixed(c): ...
