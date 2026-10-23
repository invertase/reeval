package declare

import "github.com/invertase/reeval/sdks/go/reeval"

func EvalEnvironmentExtend(e *reeval.E) {
	parent := reeval.DefineEnvironment("parent", reeval.Spec{
		Sandbox: reeval.Docker(reeval.DockerOptions{From: "node:22-bookworm"}),
	})
	e.Run("parent image", nothing, reeval.Options{Environment: parent})
	e.Run("child replaces sandbox", nothing, reeval.Options{Environment: parent.Extend("child", reeval.Spec{
		Sandbox: reeval.Docker(reeval.DockerOptions{From: "node:24-bookworm"}),
	})})
	e.Run("child keeps parent sandbox", nothing, reeval.Options{Environment: parent.Extend("kept", reeval.Spec{
		Env: map[string]string{"MODE": "x"},
	})})
}
