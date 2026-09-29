// Options as data: harness and sandbox descriptors, judge settings, environments and secrets. Each
// serialises to the JSON the reeval binary's TypeScript options take, so the binary validates and
// plans them exactly as it does a TypeScript eval's.

/// Something the binary receives as JSON.
abstract interface class Jsonable {
  Object? toJson();
}

/// Turns option values into JSON-clean data: `Jsonable`s become their JSON, nulls are dropped
/// from maps.
Object? toData(Object? value) => switch (value) {
  null || bool() || num() || String() => value,
  Jsonable() => toData(value.toJson()),
  Duration(:final inMilliseconds) => '${inMilliseconds}ms',
  Map() => {
    for (final MapEntry(:key, :value) in value.entries)
      if (value != null) '$key': toData(value),
  },
  Iterable() => [for (final item in value) toData(item)],
  _ => throw ArgumentError.value(value, 'value', 'is not JSON data or Jsonable'),
};

/// Who does the task: a harness descriptor.
sealed class Harness implements Jsonable {
  const Harness();
}

/// A fake agent that writes canned files; for tests and demos without credentials.
final class FakeHarness extends Harness {
  const FakeHarness({this.id, this.files, this.text, this.delay, this.failWith});

  final String? id;
  final Map<String, String>? files;
  final String? text;
  final Duration? delay;
  final String? failWith;

  @override
  Map<String, Object?> toJson() => {
    'kind': 'fake',
    'id': ?id,
    'files': ?files,
    'text': ?text,
    'delayMs': ?delay?.inMilliseconds,
    'failWith': ?failWith,
  };
}

/// Cursor's agent, on `model` (e.g. `composer-2.5`).
final class CursorHarness(final String model, {final Map<String, String>? params}) extends Harness {
  @override
  Map<String, Object?> toJson() => {'kind': 'cursor', 'model': model, 'params': ?params};
}

/// Claude Code, on `model`.
final class ClaudeCodeHarness(final String model) extends Harness {
  @override
  Map<String, Object?> toJson() => {'kind': 'claude-code', 'model': model};
}

Harness fakeHarness({
  String? id,
  Map<String, String>? files,
  String? text,
  Duration? delay,
  String? failWith,
}) => FakeHarness(id: id, files: files, text: text, delay: delay, failWith: failWith);

Harness cursor({required String model, Map<String, String>? params}) =>
    CursorHarness(model, params: params);

Harness claudeCode({required String model}) => ClaudeCodeHarness(model);

/// Changes the inherited harnesses instead of replacing them.
sealed class HarnessEdit implements Jsonable {
  const HarnessEdit();
}

final class AddHarnesses(final List<Harness> harnesses) extends HarnessEdit {
  @override
  Object? toJson() => {'add': harnesses};
}

final class OnlyHarnesses(final List<String> ids) extends HarnessEdit {
  @override
  Object? toJson() => {'only': ids};
}

/// Where the agent works: a sandbox descriptor.
sealed class Sandbox implements Jsonable {
  const Sandbox();
}

final class FakeSandbox extends Sandbox {
  const FakeSandbox({this.id, this.dir});

  final String? id;
  final String? dir;

  @override
  Map<String, Object?> toJson() => {'kind': 'fake', 'id': ?id, 'dir': ?dir};
}

final class DockerSandbox extends Sandbox {
  const DockerSandbox({this.id, this.image, this.from, this.dockerfile});

  final String? id;

  /// An image that already has the harness baked in.
  final String? image;

  /// A Debian or Ubuntu toolchain image (e.g. `dart:stable`); reeval bakes the harness on top.
  final String? from;

  /// An absolute path to a Dockerfile.
  final String? dockerfile;

  @override
  Map<String, Object?> toJson() => {
    'kind': 'docker',
    'id': ?id,
    'image': ?image,
    'from': ?from,
    'dockerfile': ?dockerfile,
  };
}

Sandbox fakeSandbox({String? id, String? dir}) => FakeSandbox(id: id, dir: dir);

Sandbox docker({String? id, String? image, String? from, String? dockerfile}) =>
    DockerSandbox(id: id, image: image, from: from, dockerfile: dockerfile);

/// The judge's model: `'provider/model'`, or a canned fake.
sealed class JudgeModel implements Jsonable {
  const JudgeModel();
}

final class ModelId(final String id) extends JudgeModel {
  @override
  Object? toJson() => id;
}

final class FakeJudge(final double score) extends JudgeModel {
  @override
  Object? toJson() => {'kind': 'fake-judge', 'score': score};
}

JudgeModel fakeJudge({required double score}) => FakeJudge(score);

final class Judge implements Jsonable {
  const Judge({this.model, this.threshold});

  Judge.model(String id, {double? threshold}) : this(model: ModelId(id), threshold: threshold);

  Judge.fake({required double score, double? threshold})
    : this(model: FakeJudge(score), threshold: threshold);

  final JudgeModel? model;
  final double? threshold;

  @override
  Object? toJson() => {'model': ?model, 'threshold': ?threshold};
}

/// A host environment variable passed through without its value ever being written down.
final class Secret implements Jsonable {
  const Secret({this.from, this.optional, this.hosts});

  final String? from;
  final bool? optional;

  /// Brokered: the sandbox gets a placeholder, swapped for the value only on HTTPS to these hosts.
  final List<String>? hosts;

  @override
  Object? toJson() => {'kind': 'secret', 'from': ?from, 'optional': ?optional, 'hosts': ?hosts};
}

Secret secret({String? from, bool? optional, List<String>? hosts}) =>
    Secret(from: from, optional: optional, hosts: hosts);

/// What's in the sandbox before the agent starts: files, setup commands, variables.
final class Environment implements Jsonable {
  const Environment(this.name, {this.files, this.setup, this.env, this.rules});

  final String name;
  final Map<String, String>? files;
  final List<String>? setup;
  final Map<String, Object>? env;
  final String? rules;

  @override
  Object? toJson() => {
    'kind': 'environment',
    'name': name,
    'layers': [
      {
        'name': name,
        'spec': {'files': ?files, 'setup': ?setup, 'env': ?env, 'rules': ?rules},
      },
    ],
  };
}

Environment defineEnvironment(
  String name, {
  Map<String, String>? files,
  List<String>? setup,
  Map<String, Object>? env,
  String? rules,
}) => Environment(name, files: files, setup: setup, env: env, rules: rules);

/// The options `group` and `evaluate` share, as the binary's option keys.
Map<String, Object?> optionData({
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
  final given = [harness, harnesses, harnessEdit].nonNulls;
  if (given.length > 1) {
    throw ArgumentError('Pass one of harness, harnesses or harnessEdit, not ${given.length}.');
  }
  return toData({
    'harness': given.firstOrNull,
    'sandbox': sandbox,
    'environment': environment,
    'judge': judge,
    'runs': runs,
    'tags': tags,
    'timeout': timeout,
    'env': env,
  }) as Map<String, Object?>;
}
