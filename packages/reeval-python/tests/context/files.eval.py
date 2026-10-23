import contextlib

from reeval_python import ReevalCallError, evaluate


@evaluate("files")
async def files(c):
    await c.write_file("notes/todo.md", "- buy milk\n")
    await c.read_file("notes/todo.md")
    await c.write_file("data.txt", b"hello, bytes\n")
    await c.read_file("data.txt")
    await c.read_file("missing.txt")
    await c.write_file("~/.config/app.json", '{"theme":"dark"}\n')
    await c.read_file("~/.config/app.json")
    with contextlib.suppress(ReevalCallError):
        await c.write_file("/etc/app.json", "{}")
