import 'options.dart';

/// What the binary tells the config about this invocation, before it calls `main`.
typedef ConfigContext = ({bool ci, String command, String? profile, Map<String, String> hostEnv});

ConfigContext _context = (ci: false, command: 'run', profile: null, hostEnv: const {});

/// The command, profile and CI flag the config is loaded for; set by the runner.
ConfigContext get configContext => _context;

set configContext(ConfigContext value) => _context = value;

/// A profile: `defaults` apply under every group and eval, `limit` caps them.
final class Profile implements Jsonable {
  const Profile({this.runs, this.harness, this.sandbox, this.limitRuns, this.budgetAttempts});

  final int? runs;
  final Harness? harness;
  final Sandbox? sandbox;
  final int? limitRuns;
  final int? budgetAttempts;

  @override
  Object? toJson() => {
    'defaults': {'runs': ?runs, 'harness': ?harness, 'sandbox': ?sandbox},
    if (limitRuns != null) 'limit': {'runs': limitRuns},
    if (budgetAttempts != null) 'budget': {'attempts': budgetAttempts},
  };
}

/// `reeval.config.dart`'s `main` returns one of these.
final class ReevalConfig implements Jsonable {
  const ReevalConfig._(this._data);

  final Map<String, Object?> _data;

  @override
  Object? toJson() => _data;
}

/// The eval files reeval looks for when the config doesn't say.
const defaultInclude = ['evals/**/*_eval.dart'];

ReevalConfig defineConfig({
  List<String> include = defaultInclude,
  Harness? harness,
  List<Harness>? harnesses,
  Sandbox? sandbox,
  Environment? environment,
  Judge? judge,
  int? runs,
  int? concurrency,
  Duration? timeout,
  Map<String, Object>? env,
  Map<String, Profile>? profiles,
}) {
  if (harness != null && harnesses != null) {
    throw ArgumentError('Pass harness or harnesses, not both.');
  }
  return ReevalConfig._(
    toData({
      'include': include,
      'harness': harness ?? harnesses,
      'sandbox': sandbox,
      'environment': environment,
      'judge': judge,
      'runs': runs,
      'concurrency': concurrency,
      'timeout': timeout,
      'env': env,
      'profiles': profiles,
    }) as Map<String, Object?>,
  );
}
