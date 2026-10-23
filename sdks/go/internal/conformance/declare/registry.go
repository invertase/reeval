package declare

import "github.com/invertase/reeval/sdks/go/reeval"

// Evals are the mirrors, each under its golden's name as its file.
var Evals = []reeval.InternalEval{
	{File: "compare-questions", Name: "EvalCompareQuestions", F: EvalCompareQuestions},
	{File: "compare-variants", Name: "EvalCompareVariants", F: EvalCompareVariants},
	{File: "each-families", Name: "EvalEachFamilies", F: EvalEachFamilies},
	{File: "egress-cascade", Name: "EvalEgressCascade", F: EvalEgressCascade},
	{File: "environment-extend", Name: "EvalEnvironmentExtend", F: EvalEnvironmentExtend},
	{File: "environment-plugin-marketplace", Name: "EvalEnvironmentPluginMarketplace", F: EvalEnvironmentPluginMarketplace},
	{File: "environment-plugins", Name: "EvalEnvironmentPlugins", F: EvalEnvironmentPlugins},
	{File: "groups-skip-todo", Name: "EvalGroupsSkipTodo", F: EvalGroupsSkipTodo},
	{File: "tags", Name: "EvalTags", F: EvalTags},
}
