// `group` and `evaluate` record the eval file's declaration tree, the same JSON the binary's
// `declareTree` takes (schema/plan/declaration.schema.json). Like package:test, a group's body
// runs as soon as it's declared; the binary applies `.only`, tags, profiles and the matrix.
import 'context.dart';
import 'options.dart';

enum Mode { run, skip, only }

sealed class Node implements Jsonable {
  const Node(this.name);
  final String name;
}

final class GroupNode extends Node {
  GroupNode(super.name, this.mode, this.options);
  final Mode mode;
  final Map<String, Object?> options;
  final List<Node> children = [];

  @override
  Object? toJson() => {
    'type': 'group',
    'name': name,
    'mode': mode.name,
    'options': options,
    'children': children,
  };
}

final class EvalNode extends Node {
  const EvalNode(super.name, this.mode, this.options, this.body);
  final Mode mode;
  final Map<String, Object?> options;
  final String body;

  @override
  Object? toJson() => {
    'type': 'eval',
    'name': name,
    'mode': mode.name,
    'options': options,
    'body': body,
  };
}

final class TodoNode extends Node {
  const TodoNode(super.name);

  @override
  Object? toJson() => {'type': 'todo', 'name': name};
}

typedef EvalBody = Future<void> Function(EvalContext t);

/// One eval file's declarations, recorded while its `main` runs.
final class Declarer {
  final List<Node> roots = [];
  final Map<String, EvalBody> bodies = {};
  final List<GroupNode> _open = [];

  void _add(Node node) => (_open.lastOrNull?.children ?? roots).add(node);

  Map<String, Object?> get tree => {'children': toData(roots)};
}

Declarer? _declarer;

/// Runs an eval file's `main` and returns what it declared.
Declarer declare(void Function() main) {
  final declarer = _declarer = Declarer();
  try {
    main();
  } finally {
    _declarer = null;
  }
  return declarer;
}

Declarer _current(String what) =>
    _declarer ??
    (throw StateError(
      '$what() declares evals while reeval loads the file; call it from main(), not inside an eval.',
    ));

Mode _mode(Object? skip, bool solo) => switch ((skip, solo)) {
  (true || String(), _) => Mode.skip,
  (_, true) => Mode.only,
  _ => Mode.run,
};

/// A group of evals sharing options. `skip:` (true or a reason) skips it; `solo:` runs only it.
void group(
  String name,
  void Function() body, {
  Object? skip,
  bool solo = false,
  Harness? harness,
  List<Harness>? harnesses,
  HarnessEdit? harnessEdit,
  Sandbox? sandbox,
  Environment? environment,
  Judge? judge,
  int? runs,
  List<String>? tags,
  Duration? timeout,
  Map<String, Object>? env,
}) {
  final declarer = _current('group');
  final node = GroupNode(
    name,
    _mode(skip, solo),
    optionData(
      harness: harness,
      harnesses: harnesses,
      harnessEdit: harnessEdit,
      sandbox: sandbox,
      environment: environment,
      judge: judge,
      runs: runs,
      tags: tags,
      timeout: timeout,
      env: env,
    ),
  );
  declarer._add(node);
  declarer._open.add(node);
  try {
    body();
  } finally {
    declarer._open.removeLast();
  }
}

/// One eval: a real agent does the task in `body`, which checks the result.
void evaluate(
  String name,
  EvalBody body, {
  Object? skip,
  bool solo = false,
  Harness? harness,
  List<Harness>? harnesses,
  HarnessEdit? harnessEdit,
  Sandbox? sandbox,
  Environment? environment,
  Judge? judge,
  int? runs,
  List<String>? tags,
  Duration? timeout,
  Map<String, Object>? env,
}) {
  final declarer = _current('evaluate');
  final id = 'b${declarer.bodies.length + 1}';
  declarer.bodies[id] = body;
  declarer._add(
    EvalNode(
      name,
      _mode(skip, solo),
      optionData(
        harness: harness,
        harnesses: harnesses,
        harnessEdit: harnessEdit,
        sandbox: sandbox,
        environment: environment,
        judge: judge,
        runs: runs,
        tags: tags,
        timeout: timeout,
        env: env,
      ),
      id,
    ),
  );
}

/// A placeholder eval that never runs, shown as todo.
void todo(String name) => _current('todo')._add(TodoNode(name));
