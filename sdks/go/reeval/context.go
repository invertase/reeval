package reeval

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io/fs"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/invertase/reeval/sdks/go/internal/wire"
)

// C is one attempt of an eval: the agent session, the sandbox, the judge and the checks. Its
// methods are safe to call from several goroutines; [C.Assert], [C.Fatalf] and a failing matcher
// that isn't soft end the body, so call those from the body's own goroutine, as with t.FailNow.
type C struct {
	a       *attempt
	attempt Attempt

	mu    sync.Mutex
	turns []Turn
	fatal error
}

// Attempt says which attempt a body is running: its cell of the matrix and its run number.
type Attempt struct {
	ID string `json:"id"`
	// N is the run number in its cell, from 1.
	N    int  `json:"n"`
	Cell Cell `json:"cell"`
}

// Cell is one cell of an eval's matrix.
type Cell struct {
	Key         string `json:"key"`
	Harness     string `json:"harness"`
	Environment string `json:"environment"`
	Sandbox     string `json:"sandbox"`
	// Role is "control" or "variant" in a compare.
	Role string `json:"role"`
}

// Attempt is the attempt this body runs.
func (c *C) Attempt() Attempt { return c.attempt }

// Turns are the session's turns so far, in order.
func (c *C) Turns() []Turn {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]Turn(nil), c.turns...)
}

// Send sends the agent a prompt and waits for its turn to end. The first Send starts the session
// and the sandbox.
func (c *C) Send(ctx context.Context, prompt string) (Turn, error) {
	r, err := c.a.call(ctx, wire.AttemptCallSend{Prompt: prompt})
	if err != nil {
		return Turn{}, err
	}
	var t Turn
	if err := json.Unmarshal(r.Turn, &t); err != nil {
		return Turn{}, fmt.Errorf("reeval sent a turn this SDK can't read: %w", err)
	}
	t.Raw = r.Turn
	c.mu.Lock()
	t.Index = len(c.turns)
	c.turns = append(c.turns, t)
	c.mu.Unlock()
	return t, nil
}

// Exec runs a command in the sandbox's workspace with sh and waits for it. A command that exits
// non-zero isn't an error: check ExitCode, or c.Expect(ctx, result).ToSucceed().
func (c *C) Exec(ctx context.Context, command string) (ExecResult, error) {
	r, err := c.a.call(ctx, wire.AttemptCallExec{Command: command})
	if err != nil {
		return ExecResult{}, err
	}
	var w wire.ExecResult
	if err := json.Unmarshal(r.Result, &w); err != nil {
		return ExecResult{}, fmt.Errorf("reeval sent a result this SDK can't read: %w", err)
	}
	return ExecResult{Command: command, ExitCode: w.ExitCode, Stdout: w.Stdout, Stderr: w.Stderr}, nil
}

// Start runs a command in the sandbox and leaves it running, such as a server; reeval stops it
// when the attempt ends, or Kill does sooner.
func (c *C) Start(ctx context.Context, command string) (*Process, error) {
	r, err := c.a.call(ctx, wire.AttemptCallExec{Command: command, Background: true})
	if err != nil {
		return nil, err
	}
	var h struct {
		Handle string `json:"handle"`
	}
	if err := json.Unmarshal(r.Result, &h); err != nil || h.Handle == "" {
		return nil, fmt.Errorf("reeval sent no handle for %q", command)
	}
	return &Process{Command: command, c: c, handle: h.Handle}, nil
}

// ReadFile is a file's contents in the sandbox, by workspace-relative path or `~/`. A file that
// isn't there is an error that matches [fs.ErrNotExist].
func (c *C) ReadFile(ctx context.Context, path string) (string, error) {
	r, err := c.a.call(ctx, wire.AttemptCallReadFile{Path: path})
	if err != nil {
		return "", err
	}
	if r.Contents == nil {
		return "", &fs.PathError{Op: "read", Path: path, Err: fs.ErrNotExist}
	}
	return *r.Contents, nil
}

// WriteFile writes a file into the sandbox, by workspace-relative path or `~/`, creating its
// directories. Bytes that aren't UTF-8 arrive as they are.
func (c *C) WriteFile(ctx context.Context, path string, data []byte) error {
	_, err := c.a.call(ctx, wire.AttemptCallWriteFile{
		Path: path, Contents: base64.StdEncoding.EncodeToString(data), Encoding: "base64",
	})
	return err
}

// WriteString writes text into the sandbox, as [C.WriteFile] does.
func (c *C) WriteString(ctx context.Context, path, text string) error {
	_, err := c.a.call(ctx, wire.AttemptCallWriteFile{Path: path, Contents: text})
	return err
}

// JudgeOptions change one [C.Judge] call. A zero field keeps the eval's judge settings.
type JudgeOptions struct {
	// On is what to grade instead of the latest turn: a [Turn], or a value ([ExecResult],
	// [Verdict], a string or anything JSON).
	On any
	// Model answers instead of the eval's judge: [Model] or [FakeJudge].
	Model JudgeModel
	// Threshold is the least score (0–1) that passes.
	Threshold float64
	// Extra holds judge options this struct doesn't name yet, by reeval's own key.
	Extra map[string]any
}

// Judge asks the judge a yes/no question about the latest turn, or what opts say to grade. A
// failing verdict isn't an error, and doesn't fail the attempt by itself: it's recorded, and the
// eval's gate decides; c.Expect(ctx, verdict).ToPass() makes it a check.
func (c *C) Judge(ctx context.Context, question string, opts ...JudgeOptions) (Verdict, error) {
	if len(opts) > 1 {
		return Verdict{}, usage("c.Judge takes one JudgeOptions")
	}
	call := map[string]any{"op": "judge", "question": question}
	if len(opts) == 1 {
		o, err := opts[0].wire()
		if err != nil {
			return Verdict{}, err
		}
		if len(o) > 0 {
			call["options"] = o
		}
	}
	r, err := c.a.callRaw(ctx, "judge", call)
	if err != nil {
		return Verdict{}, err
	}
	return verdict(r.Verdict)
}

func (o JudgeOptions) wire() (map[string]any, error) {
	out := deepCopy(o.Extra)
	if out == nil {
		out = map[string]any{}
	}
	if m := o.Model.wire(); m != nil {
		out["model"] = m
	}
	if o.Threshold != 0 {
		out["threshold"] = o.Threshold
	}
	if o.On != nil {
		switch on := o.On.(type) {
		case Turn:
			out["on"] = wire.JudgeCallDataOnTurn{Turn: on.Index}
		case *Turn:
			out["on"] = wire.JudgeCallDataOnTurn{Turn: on.Index}
		default:
			v, err := jsonValue(on, "JudgeOptions.On takes a Turn, an ExecResult, a Verdict or a JSON value")
			if err != nil {
				return nil, err
			}
			out["on"] = wire.JudgeCallDataOnValue{Value: v}
		}
	}
	return out, nil
}

func verdict(raw json.RawMessage) (Verdict, error) {
	var v Verdict
	if err := json.Unmarshal(raw, &v); err != nil {
		return Verdict{}, fmt.Errorf("reeval sent a verdict this SDK can't read: %w", err)
	}
	v.Raw = raw
	return v, nil
}

// Log writes a line to the attempt's log, as t.Log does: reeval shows it with -v and keeps it
// in the attempt's debug trace. fmt.Print and os.Stdout reach reeval's stderr instead, without
// the attempt's name.
func (c *C) Log(args ...any) { c.a.log("stdout", fmt.Sprintln(args...)) }

// Logf is [C.Log] with a format.
func (c *C) Logf(format string, args ...any) { c.a.log("stdout", fmt.Sprintf(format, args...)) }

// File names a file in the sandbox for [C.Poll], which reads it again on each try.
type File string

// Command names a command for [C.Poll], which runs it again on each try.
type Command string

func usage(message string) error { return &CallError{Name: "UsageError", Message: message} }

// jsonValue is v as reeval reads it: an ExecResult or a Verdict as their data, and anything else
// that encoding/json can't write refused where the eval passed it.
func jsonValue(v any, where string) (any, error) {
	switch v := v.(type) {
	case ExecResult:
		return v.wire(), nil
	case *ExecResult:
		return v.wire(), nil
	case Verdict:
		return json.RawMessage(v.Raw), nil
	case *Verdict:
		return json.RawMessage(v.Raw), nil
	}
	if _, err := json.Marshal(v); err != nil {
		return nil, usage(where + ": " + err.Error())
	}
	return v, nil
}

// attempt is one started body's side of the wire.
type attempt struct {
	key  string
	conn *conn
	ids  atomic.Int64

	abortOnce sync.Once
	aborted   chan struct{}
	abortErr  *CallError
	cancel    context.CancelFunc
}

type reply struct {
	ID        string              `json:"id"`
	OK        bool                `json:"ok"`
	Op        string              `json:"op"`
	Error     *wire.AttemptError  `json:"error"`
	Turn      json.RawMessage     `json:"turn"`
	Result    json.RawMessage     `json:"result"`
	Contents  *string             `json:"contents"`
	Assertion *assertion          `json:"assertion"`
	Verdict   json.RawMessage     `json:"verdict"`
	Untested  map[string][]string `json:"untested"`
}

type assertion struct {
	Status  string `json:"status"`
	Message string `json:"message"`
	Label   string `json:"label"`
}

func (a *attempt) next() string { return strconv.FormatInt(a.ids.Add(1), 10) }

func (a *attempt) call(ctx context.Context, call wire.AttemptCall) (*reply, error) {
	op := opOf(call)
	return a.callRaw(ctx, op, call)
}

func opOf(call wire.AttemptCall) string {
	raw, _ := json.Marshal(call)
	var head struct {
		Op string `json:"op"`
	}
	_ = json.Unmarshal(raw, &head)
	return head.Op
}

// callRaw sends one request and waits for its reply, the attempt's abort or ctx.
func (a *attempt) callRaw(ctx context.Context, op string, call any) (*reply, error) {
	select {
	case <-a.aborted:
		return nil, a.abortErr
	default:
	}
	id := a.next()
	ch := a.conn.pend(a.key, id)
	if err := a.conn.write(map[string]any{"id": id, "call": call, "key": a.key}); err != nil {
		a.conn.unpend(a.key, id)
		return nil, err
	}
	select {
	case r := <-ch:
		if !r.OK {
			e := r.Error
			if e == nil {
				e = &wire.AttemptError{Name: "Error", Message: "reeval refused the call"}
			}
			return nil, &CallError{Op: op, Name: e.Name, Message: e.Message}
		}
		return r, nil
	case <-a.aborted:
		a.conn.unpend(a.key, id)
		return nil, a.abortErr
	case <-ctx.Done():
		a.conn.unpend(a.key, id)
		return nil, context.Cause(ctx)
	}
}

// record sends a check without waiting: reeval's answer only matters when it refuses one.
func (a *attempt) record(call wire.AttemptCallRecord) {
	select {
	case <-a.aborted:
		return
	default:
	}
	id := a.next()
	a.conn.recording(a.key, id)
	if err := a.conn.write(map[string]any{"id": id, "call": call, "key": a.key}); err != nil {
		a.conn.unpend(a.key, id)
	}
}

func (a *attempt) log(stream, text string) {
	text = strings.TrimSuffix(text, "\n")
	for line := range strings.SplitSeq(text, "\n") {
		_ = a.conn.write(map[string]any{"t": "log", "key": a.key, "stream": stream, "text": strings.TrimSuffix(line, "\r")})
	}
}

// abort is reeval giving up on the body: its calls in flight and every later one fail, and done
// goes out now, since a goroutine can't be stopped.
func (a *attempt) abort(name, message string) bool {
	first := false
	a.abortOnce.Do(func() {
		first = true
		a.abortErr = &CallError{Name: name, Message: message, aborted: true}
		close(a.aborted)
		a.cancel()
	})
	return first
}
