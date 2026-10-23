// Package context mirrors reeval's context/ conformance goldens: each eval makes the calls its
// golden's runner lines are.
package context

import (
	"context"
	"errors"
	"io/fs"
	"time"

	"github.com/invertase/reeval/sdks/go/reeval"
)

const greet = "Write greet.js exporting greet(name)."

func EvalAbort(e *reeval.E) {
	e.Run("abort", func(ctx context.Context, c *reeval.C) error {
		_, err := c.Exec(ctx, "sleep 20")
		return err
	}, reeval.Options{Timeout: time.Second})
}

func EvalExec(e *reeval.E) {
	e.Run("exec", func(ctx context.Context, c *reeval.C) error {
		if _, err := c.Exec(ctx, "echo hello"); err != nil {
			return err
		}
		if _, err := c.Exec(ctx, "echo oops >&2; exit 3"); err != nil {
			return err
		}
		server, err := c.Start(ctx, "sleep 30")
		if err != nil {
			return err
		}
		if err := server.Kill(ctx); err != nil {
			return err
		}
		return server.Kill(ctx)
	})
}

func EvalExpectFail(e *reeval.E) {
	e.Run("expect-fail", func(ctx context.Context, c *reeval.C) error {
		var refused *reeval.CallError
		if err := c.Expect(ctx, 1).Matcher("toBeShiny"); !errors.As(err, &refused) {
			return errors.New("reeval didn't refuse toBeShiny")
		}
		c.Expect(ctx, 1).Named("one is two").ToBe(2)
		return nil
	})
}

func EvalExpect(e *reeval.E) {
	e.Run("expect", func(ctx context.Context, c *reeval.C) error {
		turn, err := c.Send(ctx, greet)
		if err != nil {
			return err
		}
		c.Expect(ctx, turn).ToHaveEdited("greet.js")
		c.Expect(ctx, map[string]any{"a": 1, "b": []int{2, 3}}).ToEqual(map[string]any{"a": 1, "b": []int{2, 3}})
		found, err := c.Exec(ctx, "test -f greet.js")
		if err != nil {
			return err
		}
		c.Expect(ctx, found).ToSucceed()
		var readme any
		if text, err := c.ReadFile(ctx, "README.md"); err == nil {
			readme = text
		} else if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		c.Expect(ctx, readme).ToBeNull()
		if _, err := c.Start(ctx, "sh -c 'sleep 0.3; echo ready > ready.txt'"); err != nil {
			return err
		}
		c.Poll(ctx, reeval.File("ready.txt")).Every(50 * time.Millisecond).Within(10 * time.Second).ToBe("ready\n")
		c.Poll(ctx, c).Named("the server is ready").Within(10 * time.Second).ToHaveFile("ready.txt")
		c.Expect(ctx, "draft").Soft().Named("the copy is final").ToBe("final")
		return nil
	})
}

func EvalExpectRegexp(e *reeval.E) {
	e.Run("expect-regexp", func(ctx context.Context, c *reeval.C) error {
		turn, err := c.Send(ctx, greet)
		if err != nil {
			return err
		}
		c.Expect(ctx, c).Named("greets by name").ToHaveFile("greet.js", reeval.JSRegexp(`hello, \$\{name\}`, "i"))
		c.Expect(ctx, turn).Not().ToHaveRun(reeval.JSRegexp(`^npm (test|t)$`, ""))
		return nil
	})
}

func EvalFiles(e *reeval.E) {
	e.Run("files", func(ctx context.Context, c *reeval.C) error {
		if err := c.WriteString(ctx, "notes/todo.md", "- buy milk\n"); err != nil {
			return err
		}
		if _, err := c.ReadFile(ctx, "notes/todo.md"); err != nil {
			return err
		}
		if err := c.WriteFile(ctx, "data.txt", []byte("hello, bytes\n")); err != nil {
			return err
		}
		if _, err := c.ReadFile(ctx, "data.txt"); err != nil {
			return err
		}
		if _, err := c.ReadFile(ctx, "missing.txt"); !errors.Is(err, fs.ErrNotExist) {
			return errors.New("missing.txt is there")
		}
		if err := c.WriteString(ctx, "~/.config/app.json", "{\"theme\":\"dark\"}\n"); err != nil {
			return err
		}
		if _, err := c.ReadFile(ctx, "~/.config/app.json"); err != nil {
			return err
		}
		if err := c.WriteString(ctx, "/etc/app.json", "{}"); err == nil {
			return errors.New("reeval wrote /etc/app.json")
		}
		return nil
	})
}

func EvalJudge(e *reeval.E) {
	e.Run("judge", func(ctx context.Context, c *reeval.C) error {
		first, err := c.Send(ctx, greet)
		if err != nil {
			return err
		}
		if _, err := c.Send(ctx, "Now add a test."); err != nil {
			return err
		}
		if _, err := c.Judge(ctx, "Does greet.js export greet?"); err != nil {
			return err
		}
		if _, err := c.Judge(ctx, "Is the greeting polite?", reeval.JudgeOptions{
			Model: reeval.FakeJudge(0.2), On: "Hello, Ada!",
		}); err != nil {
			return err
		}
		_, err = c.Judge(ctx, "Did the first turn write greet.js?", reeval.JudgeOptions{On: first, Threshold: 0.95})
		return err
	})
}

func EvalRecord(e *reeval.E) {
	e.Run("record", func(ctx context.Context, c *reeval.C) error {
		exists := true
		c.Assert(exists, "greet.go exists")
		result := struct{ ok bool }{ok: true}
		c.Assert(result.ok)
		c.Assert(result.ok)
		one := 1
		c.AssertEqual(one, 2, "one is two")
		return nil
	})
}

func EvalSend(e *reeval.E) {
	e.Run("send", func(ctx context.Context, c *reeval.C) error {
		if _, err := c.Send(ctx, greet); err != nil {
			return err
		}
		if _, err := c.ReadFile(ctx, "greet.js"); err != nil {
			return err
		}
		_, err := c.Send(ctx, "Now add a test.")
		return err
	})
}

func EvalSyncAsync(e *reeval.E) {
	e.Run("sync-async", func(ctx context.Context, c *reeval.C) error {
		r, err := c.Exec(ctx, "echo sync-async-ok")
		if err != nil {
			return err
		}
		c.Expect(ctx, r).ToSucceed()
		return nil
	})
}

// Evals are the mirrors, each under its golden's name as its file.
var Evals = []reeval.InternalEval{
	{File: "abort", Name: "EvalAbort", F: EvalAbort},
	{File: "exec", Name: "EvalExec", F: EvalExec},
	{File: "expect-fail", Name: "EvalExpectFail", F: EvalExpectFail},
	{File: "expect", Name: "EvalExpect", F: EvalExpect},
	{File: "expect-regexp", Name: "EvalExpectRegexp", F: EvalExpectRegexp},
	{File: "files", Name: "EvalFiles", F: EvalFiles},
	{File: "judge", Name: "EvalJudge", F: EvalJudge},
	{File: "record", Name: "EvalRecord", F: EvalRecord},
	{File: "send", Name: "EvalSend", F: EvalSend},
	{File: "sync-async", Name: "EvalSyncAsync", F: EvalSyncAsync},
}
