import 'package:reeval/reeval.dart' as reeval;
import 'package:reeval/src/declare.dart' show declare;
import 'package:test/test.dart';

void main() {
  test('records groups, evals, modes and options as the declaration tree', () {
    final declared = declare(() {
      reeval.group('greet', tags: ['smoke'], harness: reeval.fakeHarness(text: 'hi'), () {
        reeval.evaluate('writes it', (t) async {}, runs: 2, timeout: const Duration(seconds: 90));
        reeval.evaluate('skipped', (t) async {}, skip: 'flaky');
      });
      reeval.evaluate('only this', (t) async {}, solo: true);
      reeval.todo('later');
    });

    expect(declared.tree, {
      'children': [
        {
          'type': 'group',
          'name': 'greet',
          'mode': 'run',
          'options': {
            'harness': {'kind': 'fake', 'text': 'hi'},
            'tags': ['smoke'],
          },
          'children': [
            {
              'type': 'eval',
              'name': 'writes it',
              'mode': 'run',
              'options': {'runs': 2, 'timeout': '90000ms'},
              'body': 'b1',
            },
            {'type': 'eval', 'name': 'skipped', 'mode': 'skip', 'options': {}, 'body': 'b2'},
          ],
        },
        {'type': 'eval', 'name': 'only this', 'mode': 'only', 'options': {}, 'body': 'b3'},
        {'type': 'todo', 'name': 'later'},
      ],
    });
    expect(declared.bodies.keys, ['b1', 'b2', 'b3']);
  });

  test('refuses evaluate() outside an eval file being loaded', () {
    expect(() => reeval.evaluate('x', (t) async {}), throwsStateError);
  });

  test('defineConfig emits the binary option keys, without nulls', () {
    final config = reeval.defineConfig(
      sandbox: reeval.docker(from: 'dart:stable'),
      judge: reeval.Judge.model('google/gemini-3.8-flash', threshold: 0.8),
      env: {
        'KEY': reeval.secret(hosts: ['api.example.com']),
      },
    );
    expect(config.toJson(), {
      'include': ['evals/**/*_eval.dart'],
      'sandbox': {'kind': 'docker', 'from': 'dart:stable'},
      'judge': {'model': 'google/gemini-3.8-flash', 'threshold': 0.8},
      'env': {
        'KEY': {
          'kind': 'secret',
          'hosts': ['api.example.com'],
        },
      },
    });
  });

  test('a failed plain-value expectation carries both values for the diff', () {
    expect(
      () => reeval.expect('Hello', 'Ahoy'),
      throwsA(
        isA<reeval.ReevalAssertion>()
            .having((e) => e.diffable, 'diffable', isTrue)
            .having((e) => e.message, 'message', "expected 'Hello' to equal 'Ahoy'"),
      ),
    );
    expect(
      () => reeval.expect(
        reeval.ExecResult({'exitCode': 1, 'stdout': '', 'stderr': 'boom'}),
        reeval.succeeds,
      ),
      throwsA(
        isA<reeval.ReevalAssertion>().having(
          (e) => e.message,
          'message',
          contains('exited with 1; stderr:\nboom'),
        ),
      ),
    );
  });
}
