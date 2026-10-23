package reeval_test

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"testing"

	"github.com/invertase/reeval/sdks/go/reeval"
)

var attempt = map[string]any{"id": "fake/-/fake#1", "n": 1, "cell": map[string]any{
	"key": "fake/-/fake", "harness": "fake", "environment": "-", "sandbox": "fake", "role": "control",
}}

func one(name string, body reeval.Body) []reeval.InternalEval {
	return []reeval.InternalEval{{File: "evals/x_eval.go", Name: "EvalX", F: func(e *reeval.E) { e.Run(name, body) }}}
}

func startBody(r *runner, key string) {
	r.t.Helper()
	tree := r.collect("evals/x_eval.go")
	body := tree["children"].([]any)[0].(map[string]any)["body"]
	r.send(map[string]any{"type": "start", "key": key, "attempt": attempt, "file": "evals/x_eval.go", "body": body})
}

func TestGoRegexpIsAnsweredHere(t *testing.T) {
	r := start(t, one("patterns", func(ctx context.Context, c *reeval.C) error {
		c.Expect(ctx, c).ToHaveRun(regexp.MustCompile(`^npm (test|t)$`))
		return nil
	}))
	startBody(r, "k1")
	first := r.read()
	arg := first["call"].(map[string]any)["args"].([]any)[0]
	diff(t, "pattern", arg, map[string]any{"matchedBy": "^npm (test|t)$", "answers": map[string]any{}})
	r.send(map[string]any{"key": "k1", "id": first["id"], "ok": true, "op": "expect",
		"untested": map[string]any{"^npm (test|t)$": []string{"npm test", "ls"}}})
	again := r.read()
	if again["id"] == first["id"] {
		t.Errorf("the second round reused id %v", again["id"])
	}
	arg = again["call"].(map[string]any)["args"].([]any)[0]
	diff(t, "answered", arg, map[string]any{"matchedBy": "^npm (test|t)$",
		"answers": map[string]any{"npm test": true, "ls": false}})
	r.send(map[string]any{"key": "k1", "id": again["id"], "ok": true, "op": "expect",
		"assertion": map[string]any{"status": "pass"}})
	diff(t, "done", r.read(), map[string]any{"type": "done", "key": "k1"})
	r.finish()
}

func TestAbortedBodyCanTouchNothing(t *testing.T) {
	release := make(chan struct{})
	called := make(chan error, 1)
	r := start(t, one("zombie", func(ctx context.Context, c *reeval.C) error {
		_, err := c.Exec(ctx, "sleep 20")
		<-release
		_, later := c.Send(ctx, "still here?")
		called <- later
		return err
	}))
	startBody(r, "k1")
	if r.read()["call"].(map[string]any)["op"] != "exec" {
		t.Fatal("no exec")
	}
	r.send(map[string]any{"type": "abort", "key": "k1", "reason": "cancelled", "message": "stopped"})
	diff(t, "done", r.read(), map[string]any{"type": "done", "key": "k1",
		"error": map[string]any{"name": "AbortError", "message": "stopped"}})
	close(release)
	if err := <-called; !errors.Is(err, reeval.ErrAborted) {
		t.Errorf("a call after the abort returned %v", err)
	}
	startBody(r, "k2")
	if got := r.read(); got["key"] != "k2" {
		t.Errorf("the next attempt's first line is %v", got)
	}
	if rest := r.finish(); len(rest) > 0 {
		t.Errorf("the aborted body sent %v", rest)
	}
}

func TestPanicFailsOnlyItsAttempt(t *testing.T) {
	r := start(t, one("panics", func(context.Context, *reeval.C) error { panic("boom") }))
	startBody(r, "k1")
	done := r.read()
	e := done["error"].(map[string]any)
	if e["name"] != "panic" || e["message"] != "boom" || !strings.Contains(e["stack"].(string), "runner_test.go") {
		t.Errorf("done = %v", done)
	}
	startBody(r, "k2")
	if got := r.read(); got["key"] != "k2" {
		t.Errorf("the runner didn't carry on: %v", got)
	}
	r.finish()
}

func TestReturnedErrorKeepsReevalsName(t *testing.T) {
	r := start(t, one("infra", func(ctx context.Context, c *reeval.C) error {
		_, err := c.Exec(ctx, "true")
		return err
	}))
	startBody(r, "k1")
	req := r.read()
	r.send(map[string]any{"key": "k1", "id": req["id"], "ok": false, "op": "exec",
		"error": map[string]any{"name": "InfraError", "message": "docker went away"}})
	diff(t, "done", r.read(), map[string]any{"type": "done", "key": "k1",
		"error": map[string]any{"name": "InfraError", "message": "docker went away"}})
	r.finish()
}

func serverReady(c *reeval.C, ok bool) {
	c.Helper()
	c.Check(ok)
}

func TestChecksFromAHelperAreNamedAtTheCaller(t *testing.T) {
	r := start(t, one("helper", func(_ context.Context, c *reeval.C) error {
		serverUp := false
		serverReady(c, serverUp)
		return nil
	}))
	startBody(r, "k1")
	diff(t, "record", r.read()["call"], map[string]any{"op": "record", "matcher": "check",
		"subject": "serverReady(c, serverUp)", "status": "fail", "soft": true,
		"message": "check serverReady(c, serverUp)"})
	diff(t, "done", r.read(), map[string]any{"type": "done", "key": "k1"})
	r.finish()
}

func TestLoadErrorNamesThePanic(t *testing.T) {
	r := start(t, []reeval.InternalEval{{File: "evals/x_eval.go", F: func(*reeval.E) {
		reeval.PluginMarketplace("no-source", reeval.PluginOptions{})
	}}})
	r.send(map[string]any{"t": "collect", "file": "evals/x_eval.go"})
	msg := r.read()
	if msg["t"] != "load-error" || !strings.Contains(msg["error"].(map[string]any)["message"].(string), "name@source") {
		t.Errorf("collect = %v", msg)
	}
	r.finish()
}

func TestEachNamesCases(t *testing.T) {
	type person struct {
		Name string `json:"who"`
		Age  int
	}
	r := start(t, []reeval.InternalEval{{File: "f", F: func(e *reeval.E) {
		reeval.Each(e, "%# $who is $age ($missing)", []person{{"ada", 36}}, func(context.Context, *reeval.C, person) error { return nil })
		reeval.Each(e, "$k", []map[string]int{{"k": 1}, {"k": 2}}, func(context.Context, *reeval.C, map[string]int) error { return nil })
	}}})
	var names []any
	for _, n := range r.collect("f")["children"].([]any) {
		names = append(names, n.(map[string]any)["name"])
	}
	diff(t, "names", names, []any{"0 ada is 36 ($missing)", "1", "2"})
	r.finish()
}
