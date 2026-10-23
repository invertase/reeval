package reeval

import (
	"context"
	"encoding/json"

	"github.com/invertase/reeval/sdks/go/internal/wire"
)

// Turn is one turn of the agent session: what c.Send returned.
type Turn struct {
	// Index is the turn's position in the session, from 0.
	Index  int
	Prompt string
	// Text is the agent's final reply.
	Text   string
	Status string
	// Raw is the turn as reeval sent it: its transcript, usage, model and diff.
	Raw json.RawMessage
}

// ExecResult is a command's outcome in the sandbox.
type ExecResult struct {
	Command  string
	ExitCode int
	Stdout   string
	Stderr   string
}

// OK reports whether the command exited 0.
func (r *ExecResult) OK() bool { return r.ExitCode == 0 }

func (r *ExecResult) wire() *wire.ExecResult {
	return &wire.ExecResult{ExitCode: r.ExitCode, Stdout: r.Stdout, Stderr: r.Stderr}
}

// Verdict is the judge's answer to one question.
type Verdict struct {
	// Verdict is "pass" or "fail"; empty when the judge itself failed, with Error saying why.
	Verdict   string
	Score     float64
	Threshold float64
	Question  string
	Model     string
	Error     string
	Raw       json.RawMessage
}

// Passed reports whether the score reached the threshold.
func (v *Verdict) Passed() bool { return v.Verdict == "pass" }

// Process is a command left running in the sandbox by [C.Start].
type Process struct {
	Command string
	c       *C
	handle  string
}

// Kill stops the process. Killing one that has already stopped is not an error.
func (p *Process) Kill(ctx context.Context) error {
	_, err := p.c.a.call(ctx, wire.AttemptCallKill{Handle: p.handle})
	return err
}
