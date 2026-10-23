/// Write evals for coding agents in Dart: `evals/*.eval.dart` files that
/// reeval runs, each attempt a real agent in a sandbox.
///
/// ```dart
/// import 'package:reeval/reeval.dart';
///
/// void main() {
///   evaluate('writes greet', (c) async {
///     await c.send('Write lib/greet.dart with greet(name).');
///     await expectLater(c, hasFile('lib/greet.dart', RegExp('greet')));
///     expect((await c.exec('dart analyze')).exitCode, 0);
///   });
/// }
/// ```
library;

export 'package:matcher/matcher.dart'
    hide contains, equals, isFalse, isNot, isNotNull, isNull, isTrue, same;

export 'src/context.dart'
    show
        AttemptContext,
        AttemptInfo,
        BackgroundProcess,
        ExecResult,
        Poll,
        Polled,
        Turn,
        Verdict;
export 'src/declare.dart' show EvalBody, Evaluate, evaluate, group, todo;
export 'src/errors.dart' show AttemptAborted, ReevalCallError, UsageError;
export 'src/expect.dart'
    show
        ReevalMatcher,
        contains,
        equals,
        expect,
        expectLater,
        hasCalledMcp,
        hasCalledSkill,
        hasCalledTool,
        hasChanged,
        hasEdited,
        hasFetched,
        hasFile,
        hasRun,
        hasSearched,
        isFalse,
        isNot,
        isNotNull,
        isNull,
        isTrue,
        isTruthy,
        passes,
        same,
        succeeds;
export 'src/options.dart'
    show
        Compare,
        CompareGate,
        Egress,
        Environment,
        Gate,
        Harness,
        Harnesses,
        Judge,
        JudgeModel,
        Plugin,
        PluginBuild,
        Question,
        Sandbox,
        antigravity,
        claudeCode,
        codex,
        cursor,
        defaultEgressAllow,
        docker,
        fakeHarness,
        fakeJudge,
        fakeSandbox,
        fx,
        goose,
        grokBuild,
        openCode,
        pi,
        secret;
export 'src/version.dart' show packageVersion;
