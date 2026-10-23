// `group`, `evaluate` and `todo`: an eval file's `main` declares its evals, as
// a package:test file declares its tests, and reeval plans them.
import 'dart:async';
import 'dart:core' as core show Duration;
import 'dart:core' hide Duration;

import 'context.dart';
import 'options.dart';

/// An eval's body: what one attempt does, given its context.
typedef EvalBody = FutureOr<void> Function(AttemptContext c);

/// The declarations of the eval file being collected.
final class Declarer {
  final List<Map<String, Object?>> _children = [];
  final List<List<Map<String, Object?>>> _stack = [];
  final Map<String, EvalBody> bodies = {};

  static Declarer? _current;

  static Declarer get current =>
      _current ??
      (throw StateError(
        'evaluate, group and todo declare evals in an eval file\'s main(), '
        'not inside an eval body or elsewhere',
      ));

  /// Runs an eval file's [main] and returns the tree it declared.
  static Future<Map<String, Object?>> collect(Function main) async {
    final declarer = Declarer();
    _current = declarer;
    try {
      final result = main is Object? Function()
          ? main()
          : Function.apply(main, [<String>[]]);
      if (result is Future) await result;
    } finally {
      _current = null;
    }
    _last = declarer;
    return {'children': declarer._children};
  }

  static Declarer? _last;

  /// The bodies the last collected file declared.
  static Map<String, EvalBody> get lastBodies => _last?.bodies ?? const {};

  void _declare(Map<String, Object?> node) =>
      (_stack.isEmpty ? _children : _stack.last).add(node);

  String _body(EvalBody body) {
    final id = 'b${bodies.length + 1}';
    bodies[id] = body;
    return id;
  }
}

String _mode(bool skip, bool solo) => skip
    ? 'skip'
    : solo
    ? 'only'
    : 'run';

/// A group of evals and groups: its options apply to everything [body]
/// declares in it, which may add its own.
///
/// [skip] skips everything in it and [solo] runs only it (and other solos).
void group(
  String name,
  void Function() body, {
  bool skip = false,
  bool solo = false,
  Harnesses? harness,
  Sandbox? sandbox,
  Environment? environment,
  Compare? compare,
  Egress? egress,
  Gate? gate,
  Map<String, Object>? env,
  Judge? judge,
  int? runs,
  List<String>? tags,
  List<String>? pin,
  core.Duration? timeout,
  Map<String, Object?>? options,
}) {
  final declarer = Declarer.current;
  final children = <Map<String, Object?>>[];
  declarer._declare({
    'type': 'group',
    'name': name,
    'mode': _mode(skip, solo),
    'options': optionsToWire(
      harness: harness,
      sandbox: sandbox,
      environment: environment,
      compare: compare,
      egress: egress,
      gate: gate,
      env: env,
      judge: judge,
      runs: runs,
      tags: tags,
      pin: pin,
      timeout: timeout,
      options: options,
    ),
    'children': children,
  });
  declarer._stack.add(children);
  try {
    final result = (body as Object? Function())();
    if (result is Future) {
      throw ArgumentError.value(
        body,
        'body',
        'group("$name") declares its evals synchronously: drop async',
      );
    }
  } finally {
    declarer._stack.removeLast();
  }
}

/// An eval or group still to write: listed in the plan, never run.
void todo(String name) =>
    Declarer.current._declare({'type': 'todo', 'name': name});

/// Declares an eval: `evaluate('name', (c) async { … })`, or one per case with
/// [Evaluate.each].
const evaluate = Evaluate._();

/// [evaluate]'s type: call it to declare one eval.
final class Evaluate {
  const Evaluate._();

  /// Declares the eval [name], whose attempts each run [body].
  ///
  /// [skip] skips it and [solo] runs only it (and other solos). The options
  /// add to those of its groups and the config.
  void call(
    String name,
    EvalBody body, {
    bool skip = false,
    bool solo = false,
    Harnesses? harness,
    Sandbox? sandbox,
    Environment? environment,
    Compare? compare,
    Egress? egress,
    Gate? gate,
    Map<String, Object>? env,
    Judge? judge,
    int? runs,
    List<String>? tags,
    List<String>? pin,
    core.Duration? timeout,
    Map<String, Object?>? options,
  }) {
    final declarer = Declarer.current;
    declarer._declare({
      'type': 'eval',
      'name': name,
      'mode': _mode(skip, solo),
      'options': optionsToWire(
        harness: harness,
        sandbox: sandbox,
        environment: environment,
        compare: compare,
        egress: egress,
        gate: gate,
        env: env,
        judge: judge,
        runs: runs,
        tags: tags,
        pin: pin,
        timeout: timeout,
        options: options,
      ),
      'body': declarer._body(body),
    });
  }

  /// Declares one eval per case of [cases], each running [body] with its case.
  ///
  /// [name] is a template: `%s` is the case, `%#` its index, and `$field` a
  /// field of a map case (write the template as a raw string,
  /// `r'greets $name'`). The cases pool into one family, compared together,
  /// unless [pool] is false or there's only one.
  void each<T>(
    List<T> cases,
    String name,
    FutureOr<void> Function(AttemptContext c, T value) body, {
    bool pool = true,
    Harnesses? harness,
    Sandbox? sandbox,
    Environment? environment,
    Compare? compare,
    Egress? egress,
    Gate? gate,
    Map<String, Object>? env,
    Judge? judge,
    int? runs,
    List<String>? tags,
    List<String>? pin,
    core.Duration? timeout,
    Map<String, Object?>? options,
  }) {
    final declarer = Declarer.current;
    final wired = optionsToWire(
      harness: harness,
      sandbox: sandbox,
      environment: environment,
      compare: compare,
      egress: egress,
      gate: gate,
      env: env,
      judge: judge,
      runs: runs,
      tags: tags,
      pin: pin,
      timeout: timeout,
      options: options,
    );
    for (final (index, value) in cases.indexed) {
      declarer._declare({
        'type': 'eval',
        'name': caseName(name, value, index),
        'mode': 'run',
        'options': wired,
        'body': declarer._body((c) => body(c, value)),
        if (pool && cases.length > 1)
          'family': {'name': name, 'case': index, 'cases': cases.length},
      });
    }
  }
}

final _placeholder = RegExp(r'%#|%s|\$([A-Za-z_]\w*)');

/// A case's eval name from [template]. One pass, so a value that contains a
/// placeholder stays as it is.
String caseName(String template, Object? value, int index) =>
    template.replaceAllMapped(_placeholder, (m) {
      if (m[0] == '%#') return '$index';
      if (m[0] == '%s') return '$value';
      final key = m[1]!;
      return value is Map && value.containsKey(key) ? '${value[key]}' : m[0]!;
    });
