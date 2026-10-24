package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/invertase/reeval/sdks/go/reeval"
)

// project writes a module beside this SDK that uses it, with an eval package, a package that
// doesn't build, and package main.
func project(t *testing.T) string {
	t.Helper()
	sdk, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	files := map[string]string{
		"go.mod": "module example.com/evals\n\ngo 1.24.0\n\nrequire github.com/invertase/reeval/sdks/go v0.0.0\n\n" +
			"replace github.com/invertase/reeval/sdks/go => " + filepath.ToSlash(sdk) + "\n",
		"evals/greet_eval.go": `package evals

import (
	"context"
	"fmt"
	"os"
	"os/exec"

	re "github.com/invertase/reeval/sdks/go/reeval"
)

func EvalGreet(e *re.E) {
	e.Run("greets", func(ctx context.Context, c *re.C) error {
		fmt.Println("to stderr, not a message")
		cmd := exec.Command("sh", "-c", "echo from a child")
		cmd.Stdout = os.Stdout
		_ = cmd.Run()
		_, err := c.Send(ctx, "hi")
		return err
	})
}

func evalHidden(e *re.E) { e.Todo("not found: unexported") }

func helper() {}
`,
		"evals/more_eval.go": "package evals\n\nimport \"github.com/invertase/reeval/sdks/go/reeval\"\n\n" +
			"func EvalMore(e *reeval.E) { e.Todo(\"later\") }\n",
		"evals/util.go": "package evals\n\nfunc EvalNotAnEvalFile() {}\n",
		"broken/broken_eval.go": "package broken\n\nimport \"github.com/invertase/reeval/sdks/go/reeval\"\n\n" +
			"func EvalBroken(e *reeval.E) { undefined() }\n",
		"cmd/tool/main_eval.go": "package main\n\nfunc main() {}\n",
	}
	for name, src := range files {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(src), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

type session struct {
	t     *testing.T
	in    io.WriteCloser
	lines chan map[string]any
	cmd   *exec.Cmd
}

func build(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "reeval-runner")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
}

// without is the environment with no REEVAL_RUNNER variables, plus env.
func without(env ...string) []string {
	var out []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "REEVAL_RUNNER") {
			out = append(out, kv)
		}
	}
	return append(out, env...)
}

func runner(t *testing.T, root string) *session {
	t.Helper()
	cmd := exec.Command(build(t))
	cmd.Dir = root
	cmd.Env = without("REEVAL_RUNNER=stdio", "REEVAL_RUNNER_PROTOCOL="+strconv.Itoa(reeval.RunnerProtocol), "GOFLAGS=-mod=mod")
	var stderr strings.Builder
	cmd.Stderr = &stderr
	in, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	s := &session{t: t, in: in, lines: make(chan map[string]any, 64), cmd: cmd}
	go func() {
		defer close(s.lines)
		scanner := bufio.NewScanner(out)
		for scanner.Scan() {
			var msg map[string]any
			if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
				t.Errorf("stdout has a line that isn't a message: %q", scanner.Text())
				continue
			}
			if msg["t"] != "log" {
				s.lines <- msg
			}
		}
	}()
	t.Cleanup(func() {
		in.Close()
		_ = cmd.Wait()
		if t.Failed() {
			t.Log(stderr.String())
		}
	})
	return s
}

func (s *session) send(msg any) {
	data, _ := json.Marshal(msg)
	_, _ = s.in.Write(append(data, '\n'))
}

func (s *session) read() map[string]any {
	s.t.Helper()
	select {
	case msg, ok := <-s.lines:
		if !ok {
			s.t.Fatal("the runner closed its stdout")
		}
		return msg
	case <-time.After(2 * time.Minute):
		s.t.Fatal("the runner sent nothing for 2 minutes")
	}
	return nil
}

func TestBuildsEachPackageAndRunsItsBodies(t *testing.T) {
	if testing.Short() {
		t.Skip("builds programs")
	}
	s := runner(t, project(t))
	if hello := s.read(); hello["t"] != "hello" || hello["sdk"] != "go" {
		t.Fatalf("hello = %v", hello)
	}

	s.send(map[string]any{"t": "collect", "file": "broken/broken_eval.go"})
	if msg := s.read(); msg["t"] != "load-error" || !strings.Contains(msg["error"].(map[string]any)["message"].(string), "undefined") {
		t.Errorf("broken: %v", msg)
	}
	s.send(map[string]any{"t": "collect", "file": "cmd/tool/main_eval.go"})
	if msg := s.read(); msg["t"] != "load-error" || !strings.Contains(msg["error"].(map[string]any)["message"].(string), "package main") {
		t.Errorf("package main: %v", msg)
	}

	s.send(map[string]any{"t": "collect", "file": "evals/greet_eval.go"})
	s.send(map[string]any{"t": "collect", "file": "evals/more_eval.go"})
	greet := s.read()
	children := greet["tree"].(map[string]any)["children"].([]any)
	if greet["t"] != "declared" || greet["file"] != "evals/greet_eval.go" || len(children) != 1 {
		t.Fatalf("greet: %v", greet)
	}
	if more := s.read(); more["file"] != "evals/more_eval.go" {
		t.Fatalf("collects answered out of order: %v", more)
	}

	body := children[0].(map[string]any)["body"]
	s.send(map[string]any{"type": "start", "key": "k1", "file": "evals/greet_eval.go", "body": body,
		"attempt": map[string]any{"id": "a", "n": 1, "cell": map[string]any{}}})
	req := s.read()
	if req["key"] != "k1" || req["call"].(map[string]any)["op"] != "send" {
		t.Fatalf("request = %v", req)
	}
	s.send(map[string]any{"key": "k1", "id": req["id"], "ok": true, "op": "send",
		"turn": map[string]any{"prompt": "hi", "text": "hello", "status": "completed"}})
	if done := s.read(); done["type"] != "done" || done["key"] != "k1" || done["error"] != nil {
		t.Errorf("done = %v", done)
	}
}

func TestRefusesAnotherProtocolInsteadOfHello(t *testing.T) {
	bin := build(t)
	for _, c := range []struct {
		env  []string
		says string
	}{
		{nil, "run evals with go tool reeval run"},
		{[]string{"REEVAL_RUNNER=127.0.0.1:4000"}, "the reeval that started it is older"},
		{[]string{"REEVAL_RUNNER=stdio"}, "speaks runner protocol " + strconv.Itoa(reeval.RunnerProtocol) + ", but the reeval that started it speaks an older one"},
		{[]string{"REEVAL_RUNNER=stdio", "REEVAL_RUNNER_PROTOCOL=99"}, "speaks 99"},
	} {
		cmd := exec.Command(bin)
		cmd.Env = without(c.env...)
		var stdout, stderr strings.Builder
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		err := cmd.Run()
		var exit *exec.ExitError
		if !errors.As(err, &exit) || exit.ExitCode() != 2 || stdout.Len() > 0 || !strings.Contains(stderr.String(), c.says) {
			t.Errorf("%v: %v, stdout %q, stderr %q", c.env, err, stdout.String(), stderr.String())
		}
	}
}
