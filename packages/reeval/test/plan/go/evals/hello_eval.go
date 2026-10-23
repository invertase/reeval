package evals

import (
	"context"
	"time"

	"github.com/invertase/reeval/sdks/go/reeval"
)

func nothing(context.Context, *reeval.C) error { return nil }

func EvalHello(e *reeval.E) {
	e.Run("hello", nothing)
	e.Group("slow", func(e *reeval.E) {
		e.Run("twice", nothing, reeval.Options{Runs: 2, Timeout: 90 * time.Second})
		e.Run("parked", nothing, reeval.Skip())
	}, reeval.Options{Tags: []string{"slow"}})
	reeval.Each(e, "greets $name", []struct{ Name string }{{"ada"}, {"grace"}},
		func(context.Context, *reeval.C, struct{ Name string }) error { return nil })
	e.Todo("someday")
}
