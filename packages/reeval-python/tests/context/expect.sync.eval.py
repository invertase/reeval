from reeval_python import evaluate, expect


@evaluate("expect")
def expect_(c):
    turn = c.send("Write greet.js exporting greet(name).")
    expect(turn).to_have_edited("greet.js")
    expect({"a": 1, "b": [2, 3]}).to_equal({"a": 1, "b": [2, 3]})
    expect(c.exec("test -f greet.js")).to_succeed()
    expect(c.read_file("README.md")).to_be_null()
    c.exec("sh -c 'sleep 0.3; echo ready > ready.txt'", background=True)
    expect.poll(lambda: c.read_file("ready.txt"), interval=0.05, timeout=10).to_be("ready\n")
    expect.poll(c, "the server is ready", timeout=10).to_have_file("ready.txt")
    expect.soft("draft", "the copy is final").to_be("final")
