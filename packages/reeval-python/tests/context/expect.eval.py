from reeval_python import evaluate
from reeval_python.aio import expect


@evaluate("expect")
async def expect_(c):
    turn = await c.send("Write greet.js exporting greet(name).")
    await expect(turn).to_have_edited("greet.js")
    await expect({"a": 1, "b": [2, 3]}).to_equal({"a": 1, "b": [2, 3]})
    await expect(await c.exec("test -f greet.js")).to_succeed()
    await expect(await c.read_file("README.md")).to_be_null()
    await c.exec("sh -c 'sleep 0.3; echo ready > ready.txt'", background=True)
    ready = expect.poll(lambda: c.read_file("ready.txt"), interval=0.05, timeout=10)
    await ready.to_be("ready\n")
    await expect.poll(c, "the server is ready", timeout=10).to_have_file("ready.txt")
    await expect("draft", "the copy is final").to_be("final")
    await c.read_file("greet.js")
