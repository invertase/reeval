// reeval's context/ goldens, replayed through the real runner, with the test
// as reeval. Each `test/context/<case>[.<variant>].eval.dart` mirrors one
// golden: its body must send exactly the golden's `runner` lines, given the
// golden's `reeval` lines as replies.
import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:test/test.dart';

import 'support/runner_process.dart';

final mirrorsDir = p.join(Directory.current.path, 'test', 'context');

String caseOf(String mirror) =>
    p.basename(mirror).split('.').first.replaceAll('_', '-');

List<Map<String, Object?>> golden(String name) => [
  for (final line in File(
    p.join(conformance, 'context', '$name.ndjson'),
  ).readAsLinesSync())
    if (line.trim().isNotEmpty) jsonDecode(line) as Map<String, Object?>,
];

Map<String, Object?> withoutStack(Map<String, Object?> message) => {
  ...message,
  if (message['error'] case final Map<String, Object?> error)
    'error': {'name': error['name'], 'message': error['message']},
};

void main() {
  final mirrors = [
    for (final file in Directory(mirrorsDir).listSync())
      if (file.path.endsWith('.eval.dart')) p.basename(file.path),
  ]..sort();

  for (final mirror in mirrors) {
    test(mirror, () async {
      final lines = golden(caseOf(mirror));
      final runner = await Runner.start(mirrorsDir);
      addTearDown(runner.kill);
      final declared = await runner.collect(mirror);
      final tree = declared['tree'] as Map<String, Object?>;
      final [node as Map<String, Object?>] = tree['children'] as List<Object?>;
      expect(
        node['options'],
        lines.first['options'],
        reason: "the mirror declares the golden's options",
      );

      // The transport's `key` isn't in the goldens, which are the attempt
      // protocol's own lines.
      for (final line in lines.skip(1)) {
        if (line['reeval'] case final Map<String, Object?> message) {
          runner.send({
            ...message,
            if (message['type'] == 'start') ...{
              'file': mirror,
              'body': node['body'],
            },
            'key': 'k1',
          });
        } else if (line['runner'] case final Map<String, Object?> expected) {
          final sent = await runner.read(timeout: const Duration(seconds: 20));
          expect(sent.remove('key'), 'k1');
          expect(withoutStack(sent), expected);
        }
      }
      expect(
        await runner.finish(),
        isEmpty,
        reason: "the runner sent nothing after the golden's last line",
      );
    });
  }

  test('every golden has a mirror', () {
    final goldens = {
      for (final file in Directory(p.join(conformance, 'context')).listSync())
        if (file.path.endsWith('.ndjson'))
          p.basenameWithoutExtension(file.path),
    };
    expect(mirrors.map(caseOf).toSet(), goldens);
  });
}
