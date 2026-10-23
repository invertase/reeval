// The runner reeval starts (`dart run reeval:runner`): it collects eval files'
// declarations and runs their bodies, speaking reeval's runner protocol on
// private copies of its stdin and stdout. Each eval file runs in an isolate of
// its own, which this one relays messages to and from.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'fds.dart';
import 'version.dart';

/// Serves reeval until it closes the runner's stdin.
Future<void> serve() async {
  if (mismatch(Platform.environment) case final problem?) {
    stderr.writeln(problem);
    exit(2);
  }
  final root = Directory(
    Platform.environment['REEVAL_PROJECT_ROOT'] ?? Directory.current.path,
  ).absolute.path;
  final channel = MessageChannel.open();
  channel.send({
    't': 'hello',
    'protocol': runnerProtocol,
    'sdk': 'dart',
    'version': packageVersion,
    'runtime': Platform.version.split(' ').first,
  });
  final runner = _Runner(channel, root);
  await channel.input.forEach(runner.handle);
  exit(0);
}

/// Why this runner can't serve the reeval that started it, or null when it can.
String? mismatch(Map<String, String> env) {
  final startedBy = env['REEVAL_RUNNER'];
  if (startedBy == null) {
    return "This is reeval's Dart runner; run evals with `dart run reeval run`.";
  }
  final ours =
      'package:reeval $packageVersion speaks runner protocol $runnerProtocol';
  if (startedBy != 'stdio') {
    return '$ours, but the reeval that started it is older: '
        'use the reeval that matches it.';
  }
  final theirs = env['REEVAL_RUNNER_PROTOCOL'];
  if (theirs != '$runnerProtocol') {
    return '$ours, but the reeval that started it speaks '
        '${theirs ?? 'an older one'}: '
        'use the package:reeval version that matches reeval.';
  }
  return null;
}

final class _EvalFile {
  _EvalFile(this.file);

  final String file;
  SendPort? port;
  final live = <String>{};
}

final class _Runner {
  _Runner(this._channel, this._root);

  final MessageChannel _channel;
  final String _root;
  final _files = <String, _EvalFile>{};
  final _byKey = <String, _EvalFile>{};

  /// Collects run one after another, so reeval hears `declared` in order.
  var _collecting = Future<void>.value();

  void handle(String line) {
    if (line.trim().isEmpty) return;
    final Object? decoded;
    try {
      decoded = jsonDecode(line);
    } on FormatException {
      stderr.writeln(
        "reeval sent a line that isn't JSON: "
        '${line.length > 200 ? line.substring(0, 200) : line}',
      );
      return;
    }
    if (decoded is! Map<String, Object?>) return;
    switch (decoded) {
      case {'t': 'collect', 'file': final String file}:
        _collecting = _collecting.then((_) => _collect(file));
      case {
        'type': 'start',
        'key': final String key,
        'file': final String file,
      }:
        final eval = _files[file];
        if (eval?.port case final port?) {
          _byKey[key] = eval!;
          eval.live.add(key);
          port.send(decoded);
        } else {
          _channel.send({
            'type': 'done',
            'key': key,
            'error': {
              'name': 'Error',
              'message':
                  "reeval started a body of $file, which this runner "
                  "hasn't collected",
            },
          });
        }
      case {'type': 'abort', 'key': final String key}:
        _byKey[key]?.port?.send(decoded);
      case {'type': 'abort'}:
        stderr.writeln('reeval sent an abort without a key: $line');
      case {'id': _, 'ok': _, 'key': final String key}:
        _byKey[key]?.port?.send(decoded);
    }
  }

  Future<void> _collect(String file) async {
    final eval = _EvalFile(file);
    final ready = Completer<void>();
    final inbox = ReceivePort();
    final exited = ReceivePort();
    final errors = ReceivePort();
    inbox.listen((message) {
      if (message is SendPort) {
        eval.port = message;
        message.send({'t': 'collect', 'file': file});
        return;
      }
      final msg = (message as Map).cast<String, Object?>();
      if (msg case {'type': 'done', 'key': final String key}) {
        eval.live.remove(key);
        _byKey.remove(key);
      }
      _channel.send(msg);
      if (msg['t'] == 'declared' || msg['t'] == 'load-error') {
        if (!ready.isCompleted) ready.complete();
      }
    });
    errors.listen((message) {
      final [error, stack] = (message as List).cast<String?>();
      stderr.writeln('An error in $file outside an eval body: $error\n$stack');
    });
    exited.listen((_) {
      for (final key in [...eval.live]) {
        _byKey.remove(key);
        _channel.send({
          'type': 'done',
          'key': key,
          'error': {
            'name': 'Error',
            'message': "$file's isolate exited while the body was running",
          },
        });
      }
      eval.live.clear();
      inbox.close();
      errors.close();
      exited.close();
      if (!ready.isCompleted) {
        ready.complete();
        _channel.send({
          't': 'load-error',
          'error': {
            'name': 'Error',
            'message': '$file exited before it declared its evals',
          },
        });
      }
    });
    final bootstrap = _bootstrap(file);
    try {
      await Isolate.spawnUri(
        bootstrap,
        const [],
        inbox.sendPort,
        packageConfig: await Isolate.packageConfig,
        onExit: exited.sendPort,
        onError: errors.sendPort,
        errorsAreFatal: false,
        checked: true,
        debugName: file,
      );
    } on IsolateSpawnException catch (error) {
      inbox.close();
      errors.close();
      exited.close();
      _channel.send({
        't': 'load-error',
        'error': {
          'name': 'CompileError',
          'message': _compileMessage(file, error.message, bootstrap),
        },
      });
      return;
    }
    _files[file] = eval;
    await ready.future;
  }

  /// An isolate entry that hands the eval file's `main` to the SDK.
  Uri _bootstrap(String file) {
    final uri = Uri.directory(_root).resolve(file);
    return Uri.dataFromString(
      [
        "import 'package:reeval/src/eval_isolate.dart' as reeval;",
        "import '$uri' as eval;",
        'void main(List<String> _, Object? host) => '
            'reeval.serveEvalFile(host, eval.main);',
      ].join('\n'),
      mimeType: 'application/dart',
      encoding: utf8,
    );
  }

  String _compileMessage(String file, String message, Uri bootstrap) {
    final text = message
        .replaceAll(bootstrap.toString(), '<runner>')
        .replaceFirst(RegExp(r'^Unable to spawn isolate: '), '');
    if (text.contains("Undefined name 'main'") &&
        !text.contains('Error when reading')) {
      return '$file has no main(): an eval file declares its evals in '
          'void main() { evaluate(…); }';
    }
    return "$file doesn't compile:\n$text";
  }
}
