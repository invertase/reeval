/// Write evals for coding agents in Dart; the reeval binary plans and runs them.
library;

export 'package:matcher/matcher.dart';

export 'src/context.dart'
    show
        AbortedError,
        AttemptInfo,
        Checks,
        EvalContext,
        ExecResult,
        ReevalCallError,
        TokenUsage,
        Turn,
        Verdict;
export 'src/declare.dart' show EvalBody, evaluate, group, todo;
export 'src/expect.dart'
    show
        AsyncMatcher,
        ReevalAssertion,
        exitsWith,
        expect,
        expectLater,
        hasFile,
        passes,
        succeeds,
        usedTool;
export 'src/options.dart'
    show
        AddHarnesses,
        ClaudeCodeHarness,
        CursorHarness,
        DockerSandbox,
        Environment,
        FakeHarness,
        FakeJudge,
        FakeSandbox,
        Harness,
        HarnessEdit,
        Judge,
        JudgeModel,
        ModelId,
        OnlyHarnesses,
        Sandbox,
        Secret,
        claudeCode,
        cursor,
        defineEnvironment,
        docker,
        fakeHarness,
        fakeJudge,
        fakeSandbox,
        secret;
