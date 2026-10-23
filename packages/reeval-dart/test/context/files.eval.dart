import 'dart:convert';

import 'package:reeval/reeval.dart';

void main() {
  evaluate('files', (c) async {
    await c.writeFile('notes/todo.md', '- buy milk\n');
    await c.readFile('notes/todo.md');
    await c.writeBytes('data.txt', utf8.encode('hello, bytes\n'));
    await c.readFile('data.txt');
    await c.readFile('missing.txt');
    await c.writeFile('~/.config/app.json', '{"theme":"dark"}\n');
    await c.readFile('~/.config/app.json');
    try {
      await c.writeFile('/etc/app.json', '{}');
    } on ReevalCallError {
      // reeval refuses a path outside the workspace and home.
    }
  });
}
