import 'package:reeval/reeval.dart';
import 'package:reeval/src/declare.dart';
import 'package:reeval/src/options.dart' show durationToWire;
import 'package:test/test.dart' as t;

void main() {
  t.group('caseName', () {
    t.test('fills %s, %# and \$field in one pass', () {
      t.expect(caseName('greets %s (%#)', 'ada', 2), 'greets ada (2)');
      t.expect(caseName(r'greets $who', {'who': '%s'}, 0), 'greets %s');
      t.expect(caseName(r'keeps $missing', {'who': 'x'}, 0), r'keeps $missing');
    });
  });

  t.test('durations go as reeval writes them', () {
    t.expect(durationToWire(const Duration(hours: 2)), '2h');
    t.expect(durationToWire(const Duration(minutes: 90)), '90m');
    t.expect(durationToWire(const Duration(seconds: 30)), '30s');
    t.expect(durationToWire(const Duration(milliseconds: 1500)), '1500ms');
    t.expect(durationToWire(Duration.zero), '0ms');
  });

  t.test('Plugin.marketplace refuses an entry without a source', () {
    t.expect(
      () => Plugin.marketplace('lint'),
      t.throwsA(t.isA<ArgumentError>()),
    );
    t.expect(
      () => Plugin.marketplace('f@npm:@acme/p@2.0.0', ref: 'v1'),
      t.throwsA(t.isA<ArgumentError>()),
    );
  });

  t.test('evaluate outside an eval file is refused', () {
    t.expect(() => evaluate('x', (c) {}), t.throwsA(t.isA<StateError>()));
  });

  t.test('an async group is refused', () async {
    await t.expectLater(
      Declarer.collect(() => group('g', () async {})),
      t.throwsA(t.isA<ArgumentError>()),
    );
  });

  t.test('an environment copies its data when declared', () {
    final env = <String, Object>{'MODE': 'a'};
    final environment = Environment('e', env: env);
    env['MODE'] = 'b';
    t.expect(environment.toJson(), {
      'kind': 'environment',
      'name': 'e',
      'layers': [
        {
          'name': 'e',
          'spec': {
            'env': {'MODE': 'a'},
          },
        },
      ],
    });
  });

  t.test('expect refuses a matcher only reeval can run', () {
    t.expect(
      () => expect('x', hasFile('a.txt')),
      t.throwsA(
        t.isA<ArgumentError>().having(
          (e) => '${e.message}',
          'message',
          t.contains('expectLater'),
        ),
      ),
    );
  });

  t.test("reeval's matchers check locally where they can", () {
    expect([1, 2], equals([1, 2]));
    expect('abc', contains('b'));
    expect(null, isNull);
    expect(1, isNot(same(2)));
    t.expect(() => expect(1, same(2)), t.throwsA(t.anything));
  });
}
