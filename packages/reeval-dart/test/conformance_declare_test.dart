// reeval's declare/ goldens: each `test/declare/<case>.eval.dart` mirrors one
// golden's TypeScript eval file, and running its main must declare the
// golden's tree.
import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:reeval/src/declare.dart';
import 'package:test/test.dart';

import 'declare/compare_questions.eval.dart' as compare_questions;
import 'declare/compare_variants.eval.dart' as compare_variants;
import 'declare/each_families.eval.dart' as each_families;
import 'declare/egress_cascade.eval.dart' as egress_cascade;
import 'declare/environment_extend.eval.dart' as environment_extend;
import 'declare/environment_plugin_marketplace.eval.dart'
    as environment_plugin_marketplace;
import 'declare/environment_plugins.eval.dart' as environment_plugins;
import 'declare/groups_skip_todo.eval.dart' as groups_skip_todo;
import 'declare/tags.eval.dart' as tags;
import 'support/runner_process.dart' show conformance;

const mirrors = <String, void Function()>{
  'compare-questions': compare_questions.main,
  'compare-variants': compare_variants.main,
  'each-families': each_families.main,
  'egress-cascade': egress_cascade.main,
  'environment-extend': environment_extend.main,
  'environment-plugin-marketplace': environment_plugin_marketplace.main,
  'environment-plugins': environment_plugins.main,
  'groups-skip-todo': groups_skip_todo.main,
  'tags': tags.main,
};

/// [node] with each body id as `<body>`, collecting the ids: they are opaque.
Object? withoutBodies(Object? node, List<String> found) {
  if (node is List) return [for (final n in node) withoutBodies(n, found)];
  if (node is! Map) return node;
  if (node['body'] case final body?) found.add('$body');
  return {
    for (final MapEntry(:key, :value) in node.entries)
      key: key == 'body' ? '<body>' : withoutBodies(value, found),
  };
}

void main() {
  final goldens = Directory(p.join(conformance, 'declare'));
  final cases = [
    for (final dir in goldens.listSync().whereType<Directory>())
      if (File(p.join(dir.path, 'expected.json')).existsSync())
        p.basename(dir.path),
  ]..sort();

  for (final name in cases) {
    test(name, () async {
      final main = mirrors[name];
      expect(main, isNotNull, reason: 'no Dart mirror for declare/$name');
      final expected = jsonDecode(
        File(p.join(goldens.path, name, 'expected.json')).readAsStringSync(),
      );
      final ours = <String>[];
      final theirs = <String>[];
      final actual = jsonDecode(jsonEncode(await Declarer.collect(main!)));
      expect(withoutBodies(actual, ours), withoutBodies(expected, theirs));
      expect(ours.toSet(), hasLength(theirs.length));
    });
  }

  test('every golden has a mirror', () {
    expect(mirrors.keys.toSet(), cases.toSet());
  });
}
