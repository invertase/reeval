// The process a reeval worker starts with `dart run .dart_tool/reeval/runner.dart`. It connects
// to the worker's socket and spawns the worker's eval file in an isolate of its own, then relays
// lines both ways. It imports only `dart:` libraries, so it starts before the eval file compiles,
// and a file that doesn't compile becomes that file's load error, not a dead runner.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'version.dart';

Future<void> runHost(List<String> args, {required List<String> files}) async {
  final (host, port, token) = switch ((
    Platform.environment['REEVAL_RUNNER']?.split(':'),
    Platform.environment['REEVAL_RUNNER_TOKEN'],
  )) {
    ([final host, final port], final String token) => (host, int.parse(port), token),
    _ => throw StateError(
      "This is reeval's Dart runner, which reeval starts for each eval file. Run your evals with reeval run.",
    ),
  };
  final socket = await Socket.connect(host, port);
  socket.setOption(SocketOption.tcpNoDelay, true);
  void send(Object message) =>
      socket.write('${message is String ? message : jsonEncode(message)}\n');
  send({
    't': 'hello',
    'protocol': runnerProtocol,
    'token': token,
    'sdk': 'dart',
    'version': sdkVersion,
    'runtime': Platform.version.split(' ').first,
  });

  SendPort? isolate;
  var spawned = false;
  final early = <String>[];
  final fromIsolate = ReceivePort()
    ..listen((message) {
      if (message is SendPort) {
        isolate = message;
        early.forEach(message.send);
        early.clear();
      } else if (message is String) {
        send(message);
      }
    });
  final exits = ReceivePort()
    ..listen((_) {
      stderr.writeln('The eval file\'s isolate exited.');
      exit(1);
    });

  await for (final line
      in socket.cast<List<int>>().transform(utf8.decoder).transform(const LineSplitter())) {
    if (!spawned) {
      if (jsonDecode(line) case {'t': 'collect', 'file': final String file}) {
        final error = await _spawn(file, files, fromIsolate.sendPort, exits.sendPort);
        if (error != null) {
          send({'t': 'load-error', 'error': error});
          continue;
        }
        spawned = true;
      }
    }
    if (isolate case final port?) {
      port.send(line);
    } else {
      early.add(line);
    }
  }
  exit(0);
}

/// Spawns `file` in an isolate; the error it becomes when it can't, or null.
Future<Map<String, Object?>?> _spawn(
  String file,
  List<String> files,
  SendPort replies,
  SendPort onExit,
) async {
  if (!files.contains(file)) {
    return {
      'name': 'UsageError',
      'message': "$file isn't one of the project's eval files. Dart eval files end in _eval.dart.",
    };
  }
  final entry = Uri.dataFromString('''
import 'dart:isolate';
import 'package:reeval/src/isolate.dart';
import '${Directory.current.uri.resolve(file)}' as eval;

void main(List<String> args, SendPort host) => serveIsolate(host, eval.main);
''', mimeType: 'application/dart');
  try {
    await Isolate.spawnUri(
      entry,
      const [],
      replies,
      packageConfig: await Isolate.packageConfig,
      onExit: onExit,
      debugName: file,
    );
    return null;
  } on IsolateSpawnException catch (e) {
    return {
      'name': 'CompileError',
      'message': e.message.replaceFirst('Unable to spawn isolate: ', '').trim(),
    };
  }
}
