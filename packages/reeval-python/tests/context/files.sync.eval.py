import contextlib

from reeval_python import ReevalCallError, evaluate


@evaluate("files")
def files(c):
    c.write_file("notes/todo.md", "- buy milk\n")
    c.read_file("notes/todo.md")
    c.write_file("data.txt", b"hello, bytes\n")
    c.read_file("data.txt")
    c.read_file("missing.txt")
    c.write_file("~/.config/app.json", '{"theme":"dark"}\n')
    c.read_file("~/.config/app.json")
    with contextlib.suppress(ReevalCallError):
        c.write_file("/etc/app.json", "{}")
