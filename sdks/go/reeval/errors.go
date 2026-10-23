package reeval

import "errors"

// ErrAborted matches, with [errors.Is], the error every call returns once reeval has given up on
// the attempt: its timeout ran out or the run was cancelled.
var ErrAborted = errors.New("reeval aborted the attempt")

// CallError is reeval refusing a call or failing to make it. Name is reeval's name for why, such
// as UsageError or TimeoutError.
type CallError struct {
	Op      string
	Name    string
	Message string
	aborted bool
}

func (e *CallError) Error() string { return e.Message }

// Is reports whether the call failed because the attempt was aborted.
func (e *CallError) Is(target error) bool { return target == ErrAborted && e.aborted }

// AssertionError is a failed check or matcher that ended the body: its message is the reason
// reeval records.
type AssertionError struct {
	Message string
}

func (e *AssertionError) Error() string { return e.Message }
