from reeval_python import evaluate, expect, group


# Runs beside the declared skips below, which the record marks `skip`.
@evaluate("lands")
def lands(c):
    expect(c.exec("echo ran").stdout.strip(), "ran").to_be("ran")


@evaluate("parked", mode="skip")
def parked(c):
    expect(c.exec("false")).to_succeed()


def shelved_evals():
    @evaluate("shelved")
    def shelved(c):
        expect(c.exec("false")).to_succeed()


group("shelf", shelved_evals, mode="skip")
