package evals

import (
	"context"

	"github.com/invertase/reeval/sdks/go/reeval"
)

func EvalLands(e *reeval.E) {
	e.Run("lands", func(ctx context.Context, c *reeval.C) error {
		if _, err := c.Send(ctx, "Create a file named greet.go in the workspace root whose first line is exactly: package main"); err != nil {
			return err
		}
		found, err := c.Exec(ctx, `grep -qx "package main" greet.go`)
		if err != nil {
			return err
		}
		c.Assert(found.OK(), "greet.go starts with package main")
		verdict, err := c.Judge(ctx, "Is greet.go a Go file in package main?")
		if err != nil {
			return err
		}
		c.Assert(verdict.Passed(), "judge score %v below %v", verdict.Score, verdict.Threshold)
		return nil
	})
}
