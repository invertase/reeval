package reeval_test

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	ctxmirror "github.com/invertase/reeval/sdks/go/internal/conformance/context"
	"github.com/invertase/reeval/sdks/go/internal/conformance/declare"
	"github.com/invertase/reeval/sdks/go/reeval"
)

var goldens = filepath.Join("..", "..", "..", "packages", "reeval", "test", "conformance")

// runner is the runner as reeval talks to it: the test writes reeval's lines and reads the
// runner's.
type runner struct {
	t     *testing.T
	in    *io.PipeWriter
	lines chan map[string]any
	done  chan struct{}
}

func start(t *testing.T, evals []reeval.InternalEval) *runner {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	r := &runner{t: t, in: inW, lines: make(chan map[string]any, 64), done: make(chan struct{})}
	go func() {
		reeval.MainStart(evals).Serve(inR, outW)
		outW.Close()
		close(r.done)
	}()
	go func() {
		defer close(r.lines)
		scanner := bufio.NewScanner(outR)
		scanner.Buffer(nil, 16<<20)
		for scanner.Scan() {
			var msg map[string]any
			if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
				t.Errorf("the runner wrote a line that isn't JSON: %s", scanner.Bytes())
				continue
			}
			if msg["t"] != "log" {
				r.lines <- msg
			}
		}
	}()
	hello := r.read()
	if hello["t"] != "hello" || hello["protocol"] != float64(reeval.RunnerProtocol) || hello["sdk"] != "go" {
		t.Fatalf("hello = %v", hello)
	}
	return r
}

func (r *runner) send(msg any) {
	r.t.Helper()
	data, _ := json.Marshal(msg)
	if _, err := r.in.Write(append(data, '\n')); err != nil {
		r.t.Fatal(err)
	}
}

func (r *runner) read() map[string]any {
	r.t.Helper()
	select {
	case msg, ok := <-r.lines:
		if !ok {
			r.t.Fatal("the runner closed its output")
		}
		return msg
	case <-time.After(10 * time.Second):
		r.t.Fatal("the runner sent nothing for 10s")
	}
	return nil
}

// finish closes reeval's side, as reeval does when it exits, and returns what came after.
func (r *runner) finish() []map[string]any {
	r.in.Close()
	<-r.done
	var rest []map[string]any
	for msg := range r.lines {
		rest = append(rest, msg)
	}
	return rest
}

func (r *runner) collect(file string) map[string]any {
	r.t.Helper()
	r.send(map[string]any{"t": "collect", "file": file})
	msg := r.read()
	if msg["t"] != "declared" {
		r.t.Fatalf("collect %s: %v", file, msg)
	}
	return msg["tree"].(map[string]any)
}

// bodies is the tree with each body id as "<body>", collecting the ids: they're opaque.
func bodies(v any, found *[]string) any {
	switch v := v.(type) {
	case []any:
		out := make([]any, len(v))
		for i, x := range v {
			out[i] = bodies(x, found)
		}
		return out
	case map[string]any:
		out := map[string]any{}
		for k, x := range v {
			if k == "body" {
				*found = append(*found, x.(string))
				out[k] = "<body>"
			} else if k == "children" {
				out[k] = bodies(x, found)
			} else {
				out[k] = x
			}
		}
		return out
	}
	return v
}

func readJSON(t *testing.T, path string) any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func diff(t *testing.T, what string, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		g, _ := json.MarshalIndent(got, "", "  ")
		w, _ := json.MarshalIndent(want, "", "  ")
		t.Errorf("%s:\ngot  %s\nwant %s", what, g, w)
	}
}

func TestDeclareGoldens(t *testing.T) {
	entries, err := os.ReadDir(filepath.Join(goldens, "declare"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []string
	for _, e := range entries {
		if e.IsDir() {
			cases = append(cases, e.Name())
		}
	}
	var mirrored []string
	for _, ev := range declare.Evals {
		mirrored = append(mirrored, ev.File)
	}
	if !slices.Equal(cases, mirrored) {
		t.Fatalf("goldens %v, mirrors %v", cases, mirrored)
	}
	r := start(t, declare.Evals)
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			var ours, theirs []string
			got := bodies(r.collect(name), &ours)
			want := bodies(readJSON(t, filepath.Join(goldens, "declare", name, "expected.json")), &theirs)
			diff(t, "tree", got, want)
			slices.Sort(ours)
			if len(slices.Compact(ours)) != len(theirs) {
				t.Errorf("body ids %v aren't distinct, one per eval", ours)
			}
		})
	}
	if rest := r.finish(); len(rest) > 0 {
		t.Errorf("the runner sent %v after the last collect", rest)
	}
}

func withoutStack(msg map[string]any) map[string]any {
	if e, ok := msg["error"].(map[string]any); ok {
		msg["error"] = map[string]any{"name": e["name"], "message": e["message"]}
	}
	return msg
}

func TestContextGoldens(t *testing.T) {
	files, err := filepath.Glob(filepath.Join(goldens, "context", "*.ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	var mirrored []string
	for _, ev := range ctxmirror.Evals {
		mirrored = append(mirrored, ev.File)
	}
	for _, file := range files {
		name := strings.TrimSuffix(filepath.Base(file), ".ndjson")
		if !slices.Contains(mirrored, name) {
			t.Errorf("no Go mirror for context/%s", name)
			continue
		}
		t.Run(name, func(t *testing.T) {
			data, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			var lines []map[string]any
			for line := range strings.SplitSeq(strings.TrimSpace(string(data)), "\n") {
				var msg map[string]any
				if err := json.Unmarshal([]byte(line), &msg); err != nil {
					t.Fatal(err)
				}
				lines = append(lines, msg)
			}
			r := start(t, ctxmirror.Evals)
			children := r.collect(name)["children"].([]any)
			if len(children) != 1 {
				t.Fatalf("the mirror declares %d evals", len(children))
			}
			node := children[0].(map[string]any)
			diff(t, "options", node["options"], lines[0]["options"])
			// The transport's key isn't in the goldens, which are the attempt protocol's own lines.
			for _, line := range lines[1:] {
				if msg, ok := line["reeval"].(map[string]any); ok {
					msg["key"] = "k1"
					if msg["type"] == "start" {
						msg["body"], msg["file"] = node["body"], name
					}
					r.send(msg)
				} else if want, ok := line["runner"].(map[string]any); ok {
					got := r.read()
					if got["key"] != "k1" {
						t.Fatalf("%v has no key k1", got)
					}
					delete(got, "key")
					diff(t, "runner line", withoutStack(got), want)
				}
			}
			if rest := r.finish(); len(rest) > 0 {
				t.Errorf("the runner sent %v after the golden's last line", rest)
			}
		})
	}
}
