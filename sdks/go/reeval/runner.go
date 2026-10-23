package reeval

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"runtime/debug"
	"sync"

	"github.com/invertase/reeval/sdks/go/internal/runnerenv"
	"github.com/invertase/reeval/sdks/go/internal/stdio"
	"github.com/invertase/reeval/sdks/go/internal/wire"
)

// RunnerProtocol is the runner protocol this SDK speaks; reeval refuses a runner on another.
const RunnerProtocol = 3

const modulePath = "github.com/invertase/reeval/sdks/go"

// InternalEval is one EvalXxx function of an eval file. It's exported for the main package the
// runner generates, as testing.InternalTest is for go test's; evals don't use it.
type InternalEval struct {
	// File is the eval file, relative to the project root, with forward slashes.
	File string
	Name string
	F    func(*E)
}

// M runs eval files for reeval. It's exported for the generated main package, as testing.M is.
type M struct {
	evals []InternalEval
}

// MainStart is what the generated main package calls; evals don't use it.
func MainStart(evals []InternalEval) *M { return &M{evals: evals} }

// Run serves reeval over the runner protocol until reeval closes the connection, and returns the
// exit code.
func (m *M) Run() int {
	if problem := runnerenv.Mismatch(os.LookupEnv, Version(), RunnerProtocol); problem != "" {
		fmt.Fprintln(os.Stderr, problem)
		return 2
	}
	in, out, err := stdio.Private()
	if err != nil {
		fmt.Fprintln(os.Stderr, "reeval runner:", err)
		return 1
	}
	m.Serve(in, out)
	return 0
}

// Serve is [M.Run] on the given streams: reeval's messages on in, the runner's on out.
func (m *M) Serve(in io.Reader, out io.Writer) {
	conn := &conn{out: out, pending: map[pendingKey]chan *reply{}, records: map[pendingKey]bool{}}
	s := &server{m: m, conn: conn, files: map[string]*collector{}, attempts: map[string]*attempt{}}
	_ = conn.write(map[string]any{
		"t": "hello", "protocol": RunnerProtocol, "sdk": "go", "version": Version(),
		"runtime": runtime.Version(),
	})
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var msg inbound
		if err := json.Unmarshal(line, &msg); err != nil {
			fmt.Fprintf(os.Stderr, "reeval sent a line that isn't JSON: %.200q\n", line)
			continue
		}
		msg.raw = append([]byte(nil), line...)
		s.handle(&msg)
	}
}

// Version is this SDK's module version, as the build recorded it ("(devel)" or a pseudo-version
// in a checkout).
func Version() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "0.0.0"
	}
	if info.Main.Path == modulePath {
		return info.Main.Version
	}
	for _, dep := range info.Deps {
		if dep.Path == modulePath {
			if dep.Replace != nil {
				return dep.Replace.Version
			}
			return dep.Version
		}
	}
	return "0.0.0"
}

type inbound struct {
	T       string          `json:"t"`
	Type    string          `json:"type"`
	File    string          `json:"file"`
	Key     *string         `json:"key"`
	Body    string          `json:"body"`
	Attempt json.RawMessage `json:"attempt"`
	Reason  string          `json:"reason"`
	Message string          `json:"message"`
	ID      *string         `json:"id"`
	OK      *bool           `json:"ok"`
	raw     []byte
}

type server struct {
	m    *M
	conn *conn

	mu       sync.Mutex
	files    map[string]*collector
	attempts map[string]*attempt
}

func (s *server) handle(msg *inbound) {
	switch {
	case msg.T == "collect":
		s.collect(msg.File)
	case msg.Type == "start" && msg.Key != nil:
		s.start(*msg.Key, msg)
	case msg.Type == "abort":
		if msg.Key == nil {
			fmt.Fprintf(os.Stderr, "reeval sent an abort without a key: %s\n", msg.raw)
			return
		}
		name := "AbortError"
		if msg.Reason == "timeout" {
			name = "TimeoutError"
		}
		s.mu.Lock()
		a := s.attempts[*msg.Key]
		delete(s.attempts, *msg.Key)
		s.mu.Unlock()
		if a != nil && a.abort(name, msg.Message) {
			s.done(a.key, &wire.AttemptError{Name: name, Message: msg.Message}, "")
		}
	case msg.ID != nil && msg.OK != nil && msg.Key != nil:
		var r reply
		if err := json.Unmarshal(msg.raw, &r); err == nil {
			s.conn.complete(*msg.Key, &r)
		}
	}
}

func (s *server) collect(file string) {
	col := &collector{bodies: map[string]Body{}}
	err := func() (err error) {
		defer func() {
			if r := recover(); r != nil {
				err = &panicked{value: r, stack: debug.Stack()}
			}
		}()
		for _, ev := range s.m.evals {
			if ev.File == file {
				ev.F(&E{col: col, children: &col.children})
			}
		}
		return nil
	}()
	col.mu.Lock()
	col.closed = true
	col.mu.Unlock()
	if err != nil {
		_ = s.conn.write(map[string]any{"t": "load-error", "error": wireError(err)})
		return
	}
	s.mu.Lock()
	s.files[file] = col
	s.mu.Unlock()
	_ = s.conn.write(map[string]any{"t": "declared", "file": file, "tree": map[string]any{"children": trees(col.children)}})
}

func (s *server) start(key string, msg *inbound) {
	s.mu.Lock()
	col := s.files[msg.File]
	s.mu.Unlock()
	var body Body
	if col != nil {
		body = col.bodies[msg.Body]
	}
	if body == nil {
		s.done(key, &wire.AttemptError{Name: "UsageError",
			Message: fmt.Sprintf("the runner has no body %s in %s; it collects a file before running it", msg.Body, msg.File)}, "")
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	a := &attempt{key: key, conn: s.conn, aborted: make(chan struct{}), cancel: cancel}
	c := &C{a: a}
	_ = json.Unmarshal(msg.Attempt, &c.attempt)
	s.mu.Lock()
	s.attempts[key] = a
	s.mu.Unlock()
	go s.run(ctx, a, c, body)
}

func (s *server) run(ctx context.Context, a *attempt, c *C, body Body) {
	var err error
	returned := false
	defer func() {
		var stack string
		if r := recover(); r != nil {
			p := &panicked{value: r, stack: debug.Stack()}
			err, stack = p, string(p.stack)
		} else if fatal := c.lastFailure(); fatal != nil {
			err = fatal
		} else if !returned {
			err = errors.New("the body called runtime.Goexit")
		}
		a.cancel()
		s.mu.Lock()
		live := s.attempts[a.key] == a
		delete(s.attempts, a.key)
		s.mu.Unlock()
		if !live {
			return
		}
		var w *wire.AttemptError
		if err != nil {
			w = wireError(err)
		}
		s.done(a.key, w, stack)
	}()
	err = body(ctx, c)
	returned = true
}

func (s *server) done(key string, e *wire.AttemptError, stack string) {
	msg := map[string]any{"type": "done", "key": key}
	if e != nil {
		werr := map[string]any{"name": e.Name, "message": e.Message}
		if stack != "" {
			werr["stack"] = stack
		}
		msg["error"] = werr
	}
	_ = s.conn.write(msg)
}

type panicked struct {
	value any
	stack []byte
}

func (p *panicked) Error() string { return fmt.Sprint(p.value) }

func wireError(err error) *wire.AttemptError {
	var (
		call   *CallError
		failed *AssertionError
		p      *panicked
	)
	switch {
	case errors.As(err, &failed):
		return &wire.AttemptError{Name: "AssertionError", Message: failed.Message}
	case errors.As(err, &call):
		return &wire.AttemptError{Name: call.Name, Message: err.Error()}
	case errors.As(err, &p):
		return &wire.AttemptError{Name: "panic", Message: p.Error()}
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return &wire.AttemptError{Name: "AbortError", Message: err.Error()}
	}
	return &wire.AttemptError{Name: "Error", Message: err.Error()}
}

type pendingKey struct{ key, id string }

// conn is the runner's side of the wire: one JSON message a line, from any goroutine.
type conn struct {
	mu      sync.Mutex
	out     io.Writer
	pending map[pendingKey]chan *reply
	records map[pendingKey]bool
}

func (c *conn) write(msg any) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	_, err = c.out.Write(append(data, '\n'))
	return err
}

func (c *conn) pend(key, id string) chan *reply {
	ch := make(chan *reply, 1)
	c.mu.Lock()
	c.pending[pendingKey{key, id}] = ch
	c.mu.Unlock()
	return ch
}

func (c *conn) recording(key, id string) {
	c.mu.Lock()
	c.records[pendingKey{key, id}] = true
	c.mu.Unlock()
}

func (c *conn) unpend(key, id string) {
	c.mu.Lock()
	delete(c.pending, pendingKey{key, id})
	delete(c.records, pendingKey{key, id})
	c.mu.Unlock()
}

func (c *conn) complete(key string, r *reply) {
	k := pendingKey{key, r.ID}
	c.mu.Lock()
	ch, isCall := c.pending[k]
	isRecord := c.records[k]
	delete(c.pending, k)
	delete(c.records, k)
	c.mu.Unlock()
	switch {
	case isCall:
		ch <- r
	case isRecord && !r.OK && r.Error != nil:
		_ = c.write(map[string]any{"t": "log", "key": key, "stream": "stderr",
			"text": fmt.Sprintf("reeval refused a check: %s: %s", r.Error.Name, r.Error.Message)})
	}
}
