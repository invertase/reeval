// Eval options as Dart values. Each becomes reeval's plain data, which reeval
// checks when it plans the run.
import 'dart:core' as core show Duration;
import 'dart:core' hide Duration;

import 'wire.g.dart' as wire;

/// A value that goes to reeval as plain data.
abstract interface class ToJson {
  Object? toJson();
}

/// [value] as reeval reads it: [ToJson] values as their data, a [core.Duration]
/// as a string (`'90s'`), and maps and lists copied at any depth.
Object? toWire(Object? value) => switch (value) {
  ToJson() => toWire(value.toJson()),
  core.Duration() => durationToWire(value),
  Map() => {
    for (final MapEntry(:key, :value) in value.entries)
      key.toString(): toWire(value),
  },
  Iterable() => [for (final item in value) toWire(item)],
  _ => value,
};

/// A duration as reeval writes one: `'2h'`, `'5m'`, `'30s'` or `'250ms'`.
String durationToWire(core.Duration duration) {
  final ms = duration.inMilliseconds;
  if (ms != 0 && ms % core.Duration.millisecondsPerHour == 0) {
    return '${ms ~/ core.Duration.millisecondsPerHour}h';
  }
  if (ms != 0 && ms % core.Duration.millisecondsPerMinute == 0) {
    return '${ms ~/ core.Duration.millisecondsPerMinute}m';
  }
  if (ms != 0 && ms % core.Duration.millisecondsPerSecond == 0) {
    return '${ms ~/ core.Duration.millisecondsPerSecond}s';
  }
  return '${ms}ms';
}

/// The package registries and code hosts an install step needs, for an
/// [Egress.allow] list that adds to them:
/// `Egress.allow([...defaultEgressAllow, 'api.example.com'])`.
const defaultEgressAllow = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'github.com',
  '*.github.com',
  '*.githubusercontent.com',
  'pypi.org',
  'files.pythonhosted.org',
];

/// Which agents run an eval. Each harness is its own cell of the matrix.
sealed class Harnesses implements ToJson {
  const Harnesses();

  /// Every one of [harnesses], replacing the inherited ones.
  const factory Harnesses.all(List<Harness> harnesses) = _HarnessList;

  /// [harnesses] on top of the inherited ones.
  const factory Harnesses.add(List<Harness> harnesses) = _HarnessAdd;

  /// Only those of the inherited harnesses that are among [harnesses].
  const factory Harnesses.only(List<Harness> harnesses) = _HarnessOnly;
}

/// One agent: [cursor], [claudeCode], [codex], … or [fakeHarness].
final class Harness extends Harnesses {
  /// A harness from its descriptor, for options this package has no
  /// parameter for yet (see `package:reeval/wire.dart`).
  const Harness(this.descriptor);

  final wire.HarnessDescriptor descriptor;

  @override
  Object? toJson() => descriptor;
}

final class _HarnessList extends Harnesses {
  const _HarnessList(this.harnesses);
  final List<Harness> harnesses;
  @override
  Object? toJson() => harnesses;
}

final class _HarnessAdd extends Harnesses {
  const _HarnessAdd(this.harnesses);
  final List<Harness> harnesses;
  @override
  Object? toJson() => {'add': harnesses};
}

final class _HarnessOnly extends Harnesses {
  const _HarnessOnly(this.harnesses);
  final List<Harness> harnesses;
  @override
  Object? toJson() => {'only': harnesses};
}

String? _duration(core.Duration? d) => d == null ? null : durationToWire(d);

/// Cursor's agent, on [model] (e.g. `'composer-2.5'`).
Harness cursor({
  required String model,
  String? effort,
  Map<String, String>? params,
  String? gateway,
  String? id,
  int? maxConcurrent,
  core.Duration? startTimeout,
}) => Harness(
  wire.CursorHarnessDescriptor(
    model: model,
    effort: effort,
    params: params,
    gateway: gateway,
    id: id,
    maxConcurrent: maxConcurrent,
    startTimeout: _duration(startTimeout),
  ),
);

/// Claude Code, on [model] (e.g. `'claude-sonnet-5'`).
Harness claudeCode({
  required String model,
  String? effort,
  String? gateway,
  String? id,
  int? maxConcurrent,
  core.Duration? startTimeout,
}) => Harness(
  wire.ClaudeCodeHarnessDescriptor(
    model: model,
    effort: effort,
    gateway: gateway,
    id: id,
    maxConcurrent: maxConcurrent,
    startTimeout: _duration(startTimeout),
  ),
);

/// OpenAI's Codex CLI, on [model].
Harness codex({
  required String model,
  String? effort,
  String? gateway,
  String? id,
  int? maxConcurrent,
  core.Duration? startTimeout,
}) => Harness(
  wire.CodexHarnessDescriptor(
    model: model,
    effort: effort,
    gateway: gateway,
    id: id,
    maxConcurrent: maxConcurrent,
    startTimeout: _duration(startTimeout),
  ),
);

/// Google's Antigravity CLI, on [model].
Harness antigravity({
  required String model,
  String? effort,
  String? gateway,
  String? id,
  int? maxConcurrent,
  core.Duration? startTimeout,
}) => Harness(
  wire.AntigravityHarnessDescriptor(
    model: model,
    effort: effort,
    gateway: gateway,
    id: id,
    maxConcurrent: maxConcurrent,
    startTimeout: _duration(startTimeout),
  ),
);

/// OpenCode, on [model] (`'<provider>/<model>'`).
Harness openCode({
  required String model,
  String? effort,
  String? gateway,
  String? id,
  int? maxConcurrent,
  core.Duration? startTimeout,
}) => Harness(
  wire.OpenCodeHarnessDescriptor(
    model: model,
    effort: effort,
    gateway: gateway,
    id: id,
    maxConcurrent: maxConcurrent,
    startTimeout: _duration(startTimeout),
  ),
);

/// Goose, on [model].
Harness goose({
  required String model,
  String? effort,
  String? gateway,
  String? id,
  int? maxConcurrent,
  core.Duration? startTimeout,
}) => Harness(
  wire.GooseHarnessDescriptor(
    model: model,
    effort: effort,
    gateway: gateway,
    id: id,
    maxConcurrent: maxConcurrent,
    startTimeout: _duration(startTimeout),
  ),
);

/// pi, on [model].
Harness pi({
  required String model,
  String? effort,
  String? gateway,
  String? id,
  int? maxConcurrent,
  core.Duration? startTimeout,
}) => Harness(
  wire.PiHarnessDescriptor(
    model: model,
    effort: effort,
    gateway: gateway,
    id: id,
    maxConcurrent: maxConcurrent,
    startTimeout: _duration(startTimeout),
  ),
);

/// Vercel's fx, on [model].
Harness fx({
  required String model,
  String? gateway,
  String? id,
  int? maxConcurrent,
  core.Duration? startTimeout,
}) => Harness(
  wire.FxHarnessDescriptor(
    model: model,
    gateway: gateway,
    id: id,
    maxConcurrent: maxConcurrent,
    startTimeout: _duration(startTimeout),
  ),
);

/// xAI's Grok Build CLI, on [model].
Harness grokBuild({
  required String model,
  String? effort,
  String? gateway,
  String? id,
  int? maxConcurrent,
  core.Duration? startTimeout,
}) => Harness(
  wire.GrokBuildHarnessDescriptor(
    model: model,
    effort: effort,
    gateway: gateway,
    id: id,
    maxConcurrent: maxConcurrent,
    startTimeout: _duration(startTimeout),
  ),
);

/// The fake agent, for evals that run without a real one: it writes [files],
/// replies [text], or follows [script] (one list of steps a turn, each step a
/// map such as `{'write': {'a.txt': 'hi'}}` or `{'reply': 'Done.'}`). [layout]
/// names a real agent whose files and hosts it takes, e.g. `'claude-code'`.
Harness fakeHarness({
  String? layout,
  String? text,
  Map<String, String>? files,
  List<List<Map<String, Object?>>>? script,
  core.Duration? delay,
  String? failWith,
  String? servedModel,
  String? id,
  int? maxConcurrent,
}) => Harness(
  wire.FakeHarnessDescriptor(
    layout: layout,
    text: text,
    files: files,
    script: script == null
        ? null
        : [
            for (final turn in script)
              [for (final step in turn) wire.FakeScriptStep.fromJson(step)],
          ],
    delayMs: delay?.inMilliseconds,
    failWith: failWith,
    servedModel: servedModel,
    id: id,
    maxConcurrent: maxConcurrent,
  ),
);

/// The machine an eval runs on: [docker] or [fakeSandbox].
final class Sandbox implements ToJson {
  /// A sandbox from its descriptor (see `package:reeval/wire.dart`).
  const Sandbox(this.descriptor);

  final wire.SandboxDescriptor descriptor;

  @override
  Object? toJson() => descriptor;
}

/// reeval's Docker sandbox, on another image ([from]), a [dockerfile] or with
/// [install] steps on top.
Sandbox docker({
  String? from,
  String? image,
  String? dockerfile,
  List<Object>? install,
  num? cpus,
  Object? memory,
  bool? root,
  String? id,
  int? maxConcurrent,
}) => Sandbox(
  wire.DockerSandboxDescriptor(
    from: from,
    image: image,
    dockerfile: dockerfile,
    install: install,
    cpus: cpus,
    memory: memory,
    root: root,
    id: id,
    maxConcurrent: maxConcurrent,
  ),
);

/// A sandbox that is a temporary directory on this machine, for evals with
/// the fake agent.
Sandbox fakeSandbox({String? dir, String? id, int? maxConcurrent}) => Sandbox(
  wire.FakeSandboxDescriptor(dir: dir, id: id, maxConcurrent: maxConcurrent),
);

/// Where the sandbox may connect.
sealed class Egress implements ToJson {
  const Egress();

  /// Anything, directly.
  static const Egress allowAll = _EgressMode('allow-all');

  /// Nothing but the hosts reeval adds itself (the agent's own).
  static const Egress denyAll = _EgressMode('deny-all');

  /// Anything, through reeval's egress gateway, which records each request.
  static const Egress proxy = _EgressMode('proxy');

  /// Only [hosts] (`'*.example.com'` matches subdomains) and the agent's own.
  const factory Egress.allow(List<String> hosts) = _EgressAllow;
}

final class _EgressMode extends Egress {
  const _EgressMode(this.mode);
  final String mode;
  @override
  Object? toJson() => mode;
}

final class _EgressAllow extends Egress {
  const _EgressAllow(this.hosts);
  final List<String> hosts;
  @override
  Object? toJson() => {'allow': hosts};
}

/// How each cell's attempts decide its outcome.
sealed class Gate implements ToJson {
  const Gate();

  /// Every attempt passes. The default.
  static const Gate all = _GateAll();

  /// At least [rate] (0 to 1) of the attempts pass.
  const factory Gate.passRate(double rate) = _GatePassRate;
}

final class _GateAll extends Gate {
  const _GateAll();
  @override
  Object? toJson() => 'all';
}

final class _GatePassRate extends Gate {
  const _GatePassRate(this.rate);
  final double rate;
  @override
  Object? toJson() => {'passRate': rate};
}

/// A secret from the host for the sandbox's `env`: reeval brokers it, so the
/// real value never enters the sandbox. [from] names the host variable (the
/// env key by default) and [hosts] the hosts it may go to.
wire.Secret secret({
  String? from,
  List<String>? hosts,
  bool? optional,
  String? to,
}) => wire.Secret(from: from, hosts: hosts, optional: optional, to: to);

/// A plugin's build commands, run in order from [cwd] (relative to its
/// source) or its directory.
final class PluginBuild implements ToJson {
  const PluginBuild(this.run, {this.cwd});

  final List<String> run;
  final String? cwd;

  @override
  Object? toJson() => cwd == null ? run : {'run': run, 'cwd': cwd};
}

/// An agent plugin an [Environment] installs.
final class Plugin implements ToJson {
  const Plugin._(this._json);

  final Map<String, Object?> _json;

  /// A plugin in a git repository ([repo], e.g. `'github:acme/plugins'`), at
  /// [ref] and under [path].
  factory Plugin.git(
    String repo, {
    String? ref,
    String? path,
    List<String>? only,
    PluginBuild? build,
  }) => Plugin._({
    'kind': 'plugin',
    'source': 'git',
    'repo': repo,
    'ref': ?ref,
    'path': ?path,
    'only': ?only,
    'build': ?build,
  });

  /// A plugin published to npm ([spec], e.g. `'@acme/plugin@1.2.0'`).
  factory Plugin.npm(
    String spec, {
    String? path,
    List<String>? only,
    PluginBuild? build,
  }) => Plugin._({
    'kind': 'plugin',
    'source': 'npm',
    'spec': spec,
    'path': ?path,
    'only': ?only,
    'build': ?build,
  });

  /// A plugin in this project, at [path].
  factory Plugin.local(String path, {List<String>? only, PluginBuild? build}) =>
      Plugin._({
        'kind': 'plugin',
        'source': 'local',
        'path': path,
        'only': ?only,
        'build': ?build,
      });

  /// An entry of a marketplace, as `'name@source'`: a git marketplace
  /// (`'lint@github:acme/agent-plugins'`, at [ref]) or an npm one
  /// (`'format@npm:@acme/plugins@2.0.0'`).
  factory Plugin.marketplace(
    String entry, {
    String? ref,
    List<String>? only,
    PluginBuild? build,
  }) {
    final at = entry.indexOf('@');
    final name = at < 0 ? '' : entry.substring(0, at);
    final source = at < 0 ? '' : entry.substring(at + 1).trim();
    if (name.isEmpty || source.isEmpty) {
      throw ArgumentError.value(
        entry,
        'entry',
        "Plugin.marketplace() takes 'name@source', e.g. "
            "Plugin.marketplace('lint@github:acme/agent-plugins')",
      );
    }
    final Map<String, Object?> marketplace;
    if (source.startsWith('npm:')) {
      if (ref != null) {
        throw ArgumentError.value(
          ref,
          'ref',
          'Plugin.marketplace($entry): ref picks a commit of a git marketplace; '
              'pin an npm marketplace in its spec, e.g. npm:@acme/plugins@2.0.0',
        );
      }
      marketplace = {'source': 'npm', 'spec': source.substring(4)};
    } else {
      marketplace = {'source': 'git', 'repo': source, 'ref': ?ref};
    }
    return Plugin._({
      'kind': 'plugin',
      'source': 'marketplace',
      'name': name,
      'marketplace': marketplace,
      'only': ?only,
      'build': ?build,
    });
  }

  @override
  Object? toJson() => _json;
}

/// A named environment to run evals in: the sandbox, its files and setup, the
/// agent's skills, plugins, MCP servers and rules, egress and env.
final class Environment implements ToJson {
  /// An environment of its own.
  Environment(
    String name, {
    Sandbox? sandbox,
    Egress? egress,
    Map<String, Object>? env,
    Map<String, Object>? files,
    List<Object>? setup,
    List<Plugin>? plugins,
    List<Object>? skills,
    Map<String, Object>? mcp,
    Object? rules,
    Object? workspace,
  }) : this._(name, [
         (
           name,
           _spec(
             sandbox: sandbox,
             egress: egress,
             env: env,
             files: files,
             setup: setup,
             plugins: plugins,
             skills: skills,
             mcp: mcp,
             rules: rules,
             workspace: workspace,
           ),
         ),
       ]);

  Environment._(this.name, this._layers);

  final String name;
  final List<(String, Map<String, Object?>)> _layers;

  /// A child environment named [name]: each key it sets replaces this one's.
  Environment extend(
    String name, {
    Sandbox? sandbox,
    Egress? egress,
    Map<String, Object>? env,
    Map<String, Object>? files,
    List<Object>? setup,
    List<Plugin>? plugins,
    List<Object>? skills,
    Map<String, Object>? mcp,
    Object? rules,
    Object? workspace,
  }) => Environment._(name, [
    ..._layers,
    (
      name,
      _spec(
        sandbox: sandbox,
        egress: egress,
        env: env,
        files: files,
        setup: setup,
        plugins: plugins,
        skills: skills,
        mcp: mcp,
        rules: rules,
        workspace: workspace,
      ),
    ),
  ]);

  // Copied to data now, so changing a map passed in later changes nothing.
  static Map<String, Object?> _spec({
    Sandbox? sandbox,
    Egress? egress,
    Map<String, Object>? env,
    Map<String, Object>? files,
    List<Object>? setup,
    List<Plugin>? plugins,
    List<Object>? skills,
    Map<String, Object>? mcp,
    Object? rules,
    Object? workspace,
  }) =>
      toWire({
            'sandbox': ?sandbox,
            'egress': ?egress,
            'env': ?env,
            'files': ?files,
            'setup': ?setup,
            'plugins': ?plugins,
            'skills': ?skills,
            'mcp': ?mcp,
            'rules': ?rules,
            'workspace': ?workspace,
          })
          as Map<String, Object?>;

  @override
  Object? toJson() => {
    'kind': 'environment',
    'name': name,
    'layers': [
      for (final (name, spec) in _layers) {'name': name, 'spec': spec},
    ],
  };
}

/// The model that answers a judge's questions: `JudgeModel('google/…')`, or a
/// fake one with a fixed score.
extension type const JudgeModel._(Object _json) {
  /// A model by its `'provider/model'` id.
  const JudgeModel(String id) : _json = id;

  /// A judge with a fixed [score], for evals that run without a model.
  JudgeModel.fake({required double score})
    : _json = wire.FakeJudgeData(score: score);
}

/// A judge with a fixed [score], for evals that run without a model.
JudgeModel fakeJudge({required double score}) => JudgeModel.fake(score: score);

/// Defaults for `c.judge()`, merged field by field down the groups.
final class Judge implements ToJson {
  const Judge({this.model, this.threshold, this.maxConcurrent, this.state});

  final JudgeModel? model;

  /// The score (0 to 1) a verdict needs to pass.
  final double? threshold;
  final int? maxConcurrent;

  /// What the judge sees of the attempt (see reeval's `judge.state`).
  final Map<String, Object?>? state;

  @override
  Object? toJson() => {
    'model': ?model,
    'threshold': ?threshold,
    'maxConcurrent': ?maxConcurrent,
    'state': ?state,
  };
}

/// A question a compare asks a model about two attempts side by side.
final class Question implements ToJson {
  const Question(
    this.question, {
    this.model,
    this.across,
    this.state,
    this.artifacts,
  });

  final String question;

  /// The `'provider/model'` that answers it.
  final String? model;

  /// The factor it varies when pairing: `'environment'` or `'harness'`.
  final String? across;
  final Map<String, Object?>? state;
  final Object? artifacts;

  @override
  Object? toJson() =>
      model == null && across == null && state == null && artifacts == null
      ? question
      : {
          'question': question,
          'model': ?model,
          'across': ?across,
          'state': ?state,
          'artifacts': ?artifacts,
        };
}

/// Which cells of a compare gate the eval.
enum CompareGate implements ToJson {
  /// The variants'. The default.
  variants,

  /// Every cell's, the baseline's too.
  all,

  /// None: the compare only measures.
  none;

  @override
  Object? toJson() => name;
}

/// Runs the eval in [baseline] and each of [variants], and measures the lift.
final class Compare implements ToJson {
  const Compare({
    this.baseline,
    required this.variants,
    this.questions,
    this.gate,
    this.minLift,
    this.across,
  });

  final Environment? baseline;
  final List<Environment> variants;
  final List<Question>? questions;
  final CompareGate? gate;

  /// The lift (-1 to 1) each variant needs over the baseline.
  final double? minLift;
  final String? across;

  @override
  Object? toJson() => {
    'baseline': ?baseline,
    'variants': variants,
    'questions': ?questions,
    'gate': ?gate,
    'minLift': ?minLift,
    'across': ?across,
  };
}

/// The options an eval or group declares, as reeval's data.
Map<String, Object?> optionsToWire({
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
}) =>
    toWire({
          ...?options,
          'harness': ?harness,
          'sandbox': ?sandbox,
          'environment': ?environment,
          'compare': ?compare,
          'egress': ?egress,
          'gate': ?gate,
          'env': ?env,
          'judge': ?judge,
          'runs': ?runs,
          'tags': ?tags,
          'pin': ?pin,
          'timeout': ?timeout,
        })
        as Map<String, Object?>;
