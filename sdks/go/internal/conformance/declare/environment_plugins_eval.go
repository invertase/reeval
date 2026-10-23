package declare

import "github.com/invertase/reeval/sdks/go/reeval"

func EvalEnvironmentPlugins(e *reeval.E) {
	fetched := reeval.DefineEnvironment("fetched", reeval.Spec{Plugins: []reeval.Plugin{
		reeval.PluginGit("github:acme/agent-plugins", reeval.PluginOptions{Ref: "v1.2.0", Path: "plugins/review"}),
		reeval.PluginNPM("@acme/review-plugin@1.2.0", reeval.PluginOptions{Only: []string{"skills"}}),
	}})
	e.Group("remote plugins", func(e *reeval.E) {
		e.Run("git and npm read at the attempt", nothing)
		e.Run("a child adds another", nothing, reeval.Options{Environment: fetched.Extend("pinned", reeval.Spec{
			Plugins: []reeval.Plugin{reeval.PluginGit("github:acme/agent-plugins", reeval.PluginOptions{
				Ref: "v1.3.0", Path: "plugins/review",
				Build: &reeval.Build{Run: []string{"pnpm install --frozen-lockfile", "pnpm build"}, Cwd: "."},
			})},
		})})
	}, reeval.Options{Environment: fetched})
}
