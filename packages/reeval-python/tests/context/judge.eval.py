from reeval_python import evaluate, fake_judge


@evaluate("judge")
async def judge(c):
    first = await c.send("Write greet.js exporting greet(name).")
    await c.send("Now add a test.")
    await c.judge("Does greet.js export greet?")
    await c.judge("Is the greeting polite?", model=fake_judge(score=0.2), on="Hello, Ada!")
    await c.judge("Did the first turn write greet.js?", on=first, threshold=0.95)
