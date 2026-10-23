from reeval_python import evaluate, group, todo


def parked():
    @evaluate("inside")
    def inside(c): ...

    def nested():
        @evaluate("deeper")
        def deeper(c): ...

    group("nested", nested)


group("parked", parked, mode="skip")
todo("someday")
