from reeval_python import evaluate


@evaluate("send")
def send(c):
    c.send("Write greet.js exporting greet(name).")
    c.read_file("greet.js")
    c.send("Now add a test.")
