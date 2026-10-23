package declare

import "github.com/invertase/reeval/sdks/go/reeval"

func EvalEnvironmentPluginMarketplace(e *reeval.E) {
	listed := reeval.DefineEnvironment("listed", reeval.Spec{Plugins: []reeval.Plugin{
		reeval.PluginMarketplace("lint@github:acme/agent-plugins", reeval.PluginOptions{Ref: "v3", Only: []string{"skills"}}),
		reeval.PluginMarketplace("format@npm:@acme/plugins@2.0.0", reeval.PluginOptions{}),
	}})
	e.Group("marketplace plugins", func(e *reeval.E) {
		e.Run("entries read at the attempt", nothing)
	}, reeval.Options{Environment: listed})
}
