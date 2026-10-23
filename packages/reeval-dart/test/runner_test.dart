// The runner as reeval drives it: what it says first, the checks Dart itself
// makes, what an eval can and can't reach, and the mistakes it names.
@Timeout(Duration(minutes: 2))
library;

import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:reeval/src/version.dart';
import 'package:test/test.dart';

import 'support/runner_process.dart';

/// Runs the one eval [source] declares and returns the messages it sent up to
/// and including `done`. Each request but a record gets [reply]'s answer.
Future<(List<Map<String, Object?>>, Runner)> runEval(
  String source, {
  Map<String, Object?> Function(Map<String, Object?> call)? reply,
}) async {
  final root = await project({'evals/x.eval.dart': source});
  final runner = await Runner.start(root);
  addTearDown(runner.kill);
  final declared = await runner.collect('evals/x.eval.dart');
  final tree = declared['tree'] as Map<String, Object?>?;
  if (tree == null) return ([declared], runner);
  final [node as Map<String, Object?>] = tree['children'] as List<Object?>;
  runner.send({
    'type': 'start',
    'key': 'k1',
    'attempt': attempt,
    'file': 'evals/x.eval.dart',
    'body': node['body'],
  });
  final sent = <Map<String, Object?>>[];
  while (true) {
    final message = await runner.read();
    sent.add(message);
    if (message['type'] == 'done') return (sent, runner);
    final call = message['call'] as Map<String, Object?>;
    if (reply != null && call['op'] != 'record') {
      runner.send({
        'id': message['id'],
        'ok': true,
        'op': call['op'],
        'key': 'k1',
        ...reply(call),
      });
    }
  }
}

Map<String, Object?> callOf(Map<String, Object?> message) =>
    message['call'] as Map<String, Object?>;

Map<String, Object?>? errorOf(Map<String, Object?> done) =>
    done['error'] as Map<String, Object?>?;

void main() {
  test('says hello with its protocol and version', () async {
    final runner = await Runner.start(await project({}));
    addTearDown(runner.kill);
    expect(runner.hello, {
      't': 'hello',
      'protocol': runnerProtocol,
      'sdk': 'dart',
      'version': packageVersion,
      'runtime': isA<String>(),
    });
  });

  test('refuses a reeval on another runner protocol, naming both', () async {
    for (final (env, says) in [
      (<String, String>{}, "This is reeval's Dart runner"),
      ({'REEVAL_RUNNER': 'pipe'}, 'the reeval that started it is older'),
      (
        {'REEVAL_RUNNER': 'stdio', 'REEVAL_RUNNER_PROTOCOL': '2'},
        'speaks runner protocol $runnerProtocol, but the reeval that started '
            'it speaks 2: use the package:reeval version that matches reeval.',
      ),
    ]) {
      final result = await Process.run(Platform.resolvedExecutable, [
        p.join('bin', 'runner.dart'),
      ], environment: env);
      expect(result.exitCode, 2, reason: '$env');
      expect(result.stderr, contains(says), reason: '$env');
      expect(result.stdout, isEmpty, reason: '$env');
    }
  });

  test("records expect, named by what the eval wrote", () async {
    final (sent, _) = await runEval('''
import 'package:reeval/reeval.dart';

void main() {
  evaluate('x', (c) {
    final greeting = 'hello';
    expect(greeting, startsWith('he'));
    expect(greeting.length, 5, reason: 'five letters');
    expect(greeting, contains('z'), soft: true);
    expect(greeting, isEmpty);
  });
}
''');
    expect(sent.map(callOf).take(2), [
      {
        'op': 'record',
        'matcher': 'expect',
        'subject': 'greeting',
        'status': 'pass',
      },
      {
        'op': 'record',
        'matcher': 'expect',
        'subject': 'greeting.length',
        'label': 'five letters',
        'status': 'pass',
      },
    ]);
    expect(callOf(sent[2]), {
      'op': 'record',
      'matcher': 'expect',
      'subject': 'greeting',
      'status': 'fail',
      'soft': true,
      'message': contains("Expected: contains 'z'"),
    });
    expect(callOf(sent[3]), {
      'op': 'record',
      'matcher': 'expect',
      'subject': 'greeting',
      'status': 'fail',
      'message': startsWith('Expected: empty'),
    });
    expect(errorOf(sent.last), {
      'name': 'AssertionError',
      'message': startsWith('Expected: empty'),
      'stack': contains('evals/x.eval.dart:9:'),
    });
  });

  test("a failure the body catches isn't a failed check", () async {
    final (sent, _) = await runEval('''
import 'package:reeval/reeval.dart';
import 'package:test_api/hooks.dart' show TestFailure;

void main() {
  evaluate('x', (c) {
    try {
      expect(1, 2);
    } on TestFailure {
      // expected
    }
  });
}
''');
    expect(sent, [
      {'type': 'done', 'key': 'k1'},
    ]);
  });

  test("records a failed assert with its condition as written", () async {
    final (sent, _) = await runEval('''
import 'package:reeval/reeval.dart';

void main() {
  evaluate('x', (c) {
    final files = ['a.dart'];
    assert(files.length == 2, 'two files');
  });
}
''');
    expect(callOf(sent.first), {
      'op': 'record',
      'matcher': 'assert',
      'subject': 'files.length == 2',
      'status': 'fail',
      'message': 'two files: assert files.length == 2',
    });
    expect(
      errorOf(sent.last)?['message'],
      'two files: assert files.length == 2',
    );
  });

  test('records a package:checks failure as a check', () async {
    final (sent, _) = await runEval('''
import 'package:checks/checks.dart';
import 'package:reeval/reeval.dart';

void main() {
  evaluate('x', (c) {
    final name = 'Ada';
    check(name).equals('Grace');
  });
}
''');
    expect(callOf(sent.first), {
      'op': 'record',
      'matcher': 'check',
      'subject': "check(name).equals('Grace')",
      'status': 'fail',
      'message': contains('Grace'),
    });
  });

  test('c.check records passes, and a soft failure goes on', () async {
    final (sent, _) = await runEval('''
import 'package:reeval/reeval.dart';

void main() {
  evaluate('x', (c) {
    final ok = true;
    c.check(ok);
    c.check(!ok, reason: 'not ok', soft: true);
  });
}
''');
    expect(sent.map(callOf).take(2), [
      {'op': 'record', 'matcher': 'assert', 'subject': 'ok', 'status': 'pass'},
      {
        'op': 'record',
        'matcher': 'assert',
        'subject': '!ok',
        'status': 'fail',
        'soft': true,
        'message': 'not ok: assert !ok',
      },
    ]);
    expect(sent.last, {'type': 'done', 'key': 'k1'});
  });

  test(
    "print, stdout and a child process can't reach reeval's messages",
    () async {
      final (sent, runner) = await runEval('''
import 'dart:io';

import 'package:reeval/reeval.dart';

void main() {
  evaluate('x', (c) async {
    print('from print');
    stdout.write('from stdout\\n');
    stderr.write('from stderr\\n');
    final child = await Process.start(
      'sh',
      ['-c', 'echo from a child; cat; ls /proc/self/fd 2>/dev/null | wc -l'],
      mode: ProcessStartMode.inheritStdio,
    );
    await child.exitCode;
  });
}
''');
      expect(sent, [
        {'type': 'done', 'key': 'k1'},
      ]);
      expect(runner.logs, [
        {'t': 'log', 'key': 'k1', 'stream': 'stdout', 'text': 'from print'},
        {'t': 'log', 'key': 'k1', 'stream': 'stdout', 'text': 'from stdout'},
        {'t': 'log', 'key': 'k1', 'stream': 'stderr', 'text': 'from stderr'},
      ]);
      // The child's stdout is the runner's stderr, and its stdin is empty, so
      // `cat` ends at once instead of reading reeval's next message.
      expect(await runner.finish(), isEmpty);
      expect(runner.stderr, contains('from a child'));
    },
    // Windows has no private fds: the runner talks on its own stdin and stdout.
    testOn: '!windows',
  );

  test("an unawaited expectLater is a usage error", () async {
    final (sent, _) = await runEval(
      '''
import 'package:reeval/reeval.dart';

void main() {
  evaluate('x', (c) {
    expectLater(1, 1);
  });
}
''',
      reply: (call) => {
        'assertion': {
          'label': 'toEqual 1',
          'labelled': false,
          'matcher': 'toEqual',
          'status': 'pass',
          'soft': false,
        },
      },
    );
    expect(errorOf(sent.last), {
      'name': 'UsageError',
      'message': contains('await each one'),
      'stack': isA<String>(),
    });
  });

  test(
    'a file that does not compile is a load error naming its line',
    () async {
      final (sent, _) = await runEval('''
import 'package:reeval/reeval.dart';

void main() {
  evaluate('x', (c) { final int n = 'text'; });
}
''');
      expect(sent.single, {
        't': 'load-error',
        'error': {
          'name': 'CompileError',
          'message': allOf(contains('x.eval.dart:4'), isNot(contains('data:'))),
        },
      });
    },
  );

  test('an abort fails the call in flight and ends the body once', () async {
    final root = await project({
      'evals/x.eval.dart': '''
import 'package:reeval/reeval.dart';

void main() {
  evaluate('x', (c) async {
    try {
      await c.exec('sleep 20');
    } finally {
      print('cleaned up');
    }
  });
}
''',
    });
    final runner = await Runner.start(root);
    addTearDown(runner.kill);
    final declared = await runner.collect('evals/x.eval.dart');
    final tree = declared['tree'] as Map<String, Object?>;
    final [node as Map<String, Object?>] = tree['children'] as List<Object?>;
    runner.send({
      'type': 'start',
      'key': 'k1',
      'attempt': attempt,
      'file': 'evals/x.eval.dart',
      'body': node['body'],
    });
    expect(callOf(await runner.read()), {'op': 'exec', 'command': 'sleep 20'});
    runner.send({
      'type': 'abort',
      'key': 'k1',
      'reason': 'cancelled',
      'message': 'The run was stopped',
    });
    final done = await runner.read();
    expect(done, {
      'type': 'done',
      'key': 'k1',
      'error': {'name': 'AbortError', 'message': 'The run was stopped'},
    });
    // The body's `finally` still runs, after reeval has its done.
    expect(jsonDecode(await runner.readLine()), {
      't': 'log',
      'key': 'k1',
      'stream': 'stdout',
      'text': 'cleaned up',
    });
    expect(await runner.finish(), isEmpty);
  });
}
