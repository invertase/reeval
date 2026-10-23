// Command reeval-runner is the Go eval runner reeval starts, with `go run`, for a project's
// _eval.go files. Evals don't run it themselves.
//
// It builds one program per package of eval files, as go test builds one per package of tests:
// a generated main package, added with -overlay so nothing is written into the project, that
// calls the package's EvalXxx functions. Each program speaks reeval's runner protocol; this
// command starts them and passes messages between them and reeval, so a package that doesn't
// compile fails only its own files.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"runtime"
	"sync"

	"github.com/invertase/reeval/sdks/go/internal/runnerenv"
	"github.com/invertase/reeval/sdks/go/internal/stdio"
	"github.com/invertase/reeval/sdks/go/reeval"
)

func main() {
	if problem := runnerenv.Mismatch(os.LookupEnv, reeval.Version(), reeval.RunnerProtocol); problem != "" {
		fmt.Fprintln(os.Stderr, problem)
		os.Exit(2)
	}
	root, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, "reeval-runner:", err)
		os.Exit(1)
	}
	if dir := os.Getenv("REEVAL_PROJECT_ROOT"); dir != "" {
		root = dir
	}
	in, out, err := stdio.Private()
	if err != nil {
		fmt.Fprintln(os.Stderr, "reeval-runner:", err)
		os.Exit(1)
	}
	tmp, err := os.MkdirTemp("", "reeval-go-")
	if err != nil {
		fmt.Fprintln(os.Stderr, "reeval-runner:", err)
		os.Exit(1)
	}
	d := &driver{root: root, tmp: tmp, out: out, packages: map[string]*child{}, keys: map[string]*child{}}
	d.serve(in)
	d.close()
	_ = os.RemoveAll(tmp)
}

type driver struct {
	root string
	tmp  string

	outMu sync.Mutex
	out   io.Writer

	mu       sync.Mutex
	packages map[string]*child
	keys     map[string]*child
	collects chan string
}

type head struct {
	T    string  `json:"t"`
	Type string  `json:"type"`
	Key  *string `json:"key"`
	File string  `json:"file"`
}

func (d *driver) write(line []byte) {
	d.outMu.Lock()
	defer d.outMu.Unlock()
	_, _ = d.out.Write(append(line, '\n'))
}

func (d *driver) send(msg any) {
	data, _ := json.Marshal(msg)
	d.write(data)
}

func (d *driver) serve(in io.Reader) {
	d.send(map[string]any{
		"t": "hello", "protocol": reeval.RunnerProtocol, "sdk": "go", "version": reeval.Version(),
		"runtime": runtime.Version(),
	})
	// Collects are answered in the order they came, each after its package is built, while the
	// attempts already running carry on.
	d.collects = make(chan string, 64)
	var collecting sync.WaitGroup
	collecting.Add(1)
	go func() {
		defer collecting.Done()
		for file := range d.collects {
			d.collect(file)
		}
	}()
	defer collecting.Wait()
	defer close(d.collects)

	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for scanner.Scan() {
		line := append([]byte(nil), scanner.Bytes()...)
		if len(line) == 0 {
			continue
		}
		var h head
		if err := json.Unmarshal(line, &h); err != nil {
			fmt.Fprintf(os.Stderr, "reeval sent a line that isn't JSON: %.200q\n", line)
			continue
		}
		switch {
		case h.T == "collect":
			d.collects <- h.File
		case h.Type == "start" && h.Key != nil:
			d.start(*h.Key, h.File, line)
		case h.Key != nil:
			d.mu.Lock()
			c := d.keys[*h.Key]
			d.mu.Unlock()
			if c != nil {
				c.send(line)
			}
		}
	}
}

func (d *driver) start(key, file string, line []byte) {
	d.mu.Lock()
	c := d.packages[path.Dir(file)]
	if c != nil && !c.gone {
		d.keys[key] = c
	}
	d.mu.Unlock()
	if c == nil || c.gone {
		d.send(map[string]any{"type": "done", "key": key, "error": map[string]any{
			"name": "InfraError", "message": "the Go runner has no program for " + file + "; it collects a file before running it",
		}})
		return
	}
	c.send(line)
}

func (d *driver) collect(file string) {
	dir := path.Dir(file)
	d.mu.Lock()
	c := d.packages[dir]
	d.mu.Unlock()
	if c == nil || c.gone {
		var err error
		c, err = d.build(dir)
		if err != nil {
			d.send(map[string]any{"t": "load-error", "error": map[string]any{"name": "GoBuildError", "message": err.Error()}})
			return
		}
		d.mu.Lock()
		d.packages[dir] = c
		d.mu.Unlock()
	}
	msg, _ := json.Marshal(map[string]any{"t": "collect", "file": file})
	answered := make(chan struct{})
	c.mu.Lock()
	c.collecting = answered
	c.mu.Unlock()
	c.send(msg)
	<-answered
}

func (d *driver) close() {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, c := range d.packages {
		c.stop()
	}
}
