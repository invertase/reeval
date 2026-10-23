package declare

import "github.com/invertase/reeval/sdks/go/reeval"

func EvalGroupsSkipTodo(e *reeval.E) {
	e.Group("parked", func(e *reeval.E) {
		e.Run("inside", nothing)
		e.Group("nested", func(e *reeval.E) {
			e.Run("deeper", nothing)
		})
	}, reeval.Skip())
	e.Todo("someday")
}
