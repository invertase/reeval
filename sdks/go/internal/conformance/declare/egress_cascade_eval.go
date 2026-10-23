package declare

import "github.com/invertase/reeval/sdks/go/reeval"

func EvalEgressCascade(e *reeval.E) {
	closed := reeval.DefineEnvironment("closed", reeval.Spec{Egress: reeval.EgressDenyAll})
	e.Run("the config policy", nothing)
	e.Run("an environment replaces it", nothing, reeval.Options{Environment: closed})
	e.Run("an extend child replaces its parent", nothing, reeval.Options{
		Environment: closed.Extend("reopened", reeval.Spec{Egress: reeval.EgressAllowAll}),
	})
	e.Run("the default list spreads", nothing, reeval.Options{
		Environment: reeval.DefineEnvironment("installs", reeval.Spec{
			Egress: append(reeval.DefaultEgressAllow(), "api.example.com"),
		}),
	})
	e.Run("the eval replaces the environment", nothing, reeval.Options{
		Environment: closed, Egress: reeval.EgressAllow{"eval.example.com"},
	})
	e.Group("a group", func(e *reeval.E) {
		e.Run("replaces the environment too", nothing, reeval.Options{Environment: closed})
	}, reeval.Options{Egress: reeval.EgressAllow{"group.example.com"}})
	e.Run("a variant runs under its own policy", nothing, reeval.Options{Compare: &reeval.Compare{
		Baseline: reeval.DefineEnvironment("plain", reeval.Spec{}),
		Variants: []*reeval.Environment{closed},
	}})
	e.Run("a fake agent with a layout gets that agent's hosts", nothing, reeval.Options{
		Environment: closed,
		Harness:     reeval.FakeHarness(reeval.FakeHarnessOptions{Layout: "claude-code"}),
	})
}
