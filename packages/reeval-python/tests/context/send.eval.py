from reeval_python import evaluate


@evaluate("send")
async def send(c):
    await c.send("Write greet.js exporting greet(name).")
    await c.read_file("greet.js")
    await c.send("Now add a test.")
