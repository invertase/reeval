from reeval_python import evaluate, fake_judge


@evaluate("judge")
def judge(c):
    first = c.send("Write greet.js exporting greet(name).")
    c.send("Now add a test.")
    c.judge("Does greet.js export greet?")
    c.judge("Is the greeting polite?", model=fake_judge(score=0.2), on="Hello, Ada!")
    c.judge("Did the first turn write greet.js?", on=first, threshold=0.95)
