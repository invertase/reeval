package reeval

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/invertase/reeval/sdks/go/internal/wire"
)

// Expectation is one of reeval's matchers waiting for its subject: what [C.Expect] and [C.Poll]
// return. reeval runs the matcher and records the check, named by the matcher and its arguments
// or by [Expectation.Named].
//
// A failing matcher ends the body, as t.Fatal does, unless the expectation is [Expectation.Soft]:
// then it returns false and the attempt fails once the body is done, as t.Error does.
type Expectation struct {
	c       *C
	ctx     context.Context
	subject wire.MatcherSubject
	err     error
	label   string
	not     bool
	soft    bool
	poll    *wire.AttemptCallExpectPoll
}

// Expect checks actual with one of reeval's matchers: c (the attempt: its files and latest
// turn), a [Turn], an [ExecResult], a [File] or [Command] reeval reads or runs, or any value
// encoding/json can write.
func (c *C) Expect(ctx context.Context, actual any) *Expectation {
	subject, err := subjectOf(c, actual)
	return &Expectation{c: c, ctx: ctx, subject: subject, err: err}
}

// Poll retries the matcher until it passes or the timeout (1s unless [Expectation.Within] says)
// runs out, reading the subject again each time: c, a [File] or a [Command].
//
//	c.Poll(ctx, reeval.File("ready.txt")).Within(10 * time.Second).ToBe("ready\n")
func (c *C) Poll(ctx context.Context, subject any) *Expectation {
	x := &Expectation{c: c, ctx: ctx, poll: &wire.AttemptCallExpectPoll{}}
	switch s := subject.(type) {
	case *C:
		x.subject = wire.MatcherSubjectAttempt{}
	case File:
		x.subject = wire.MatcherSubjectReadFile{ReadFile: string(s)}
	case Command:
		x.subject = wire.MatcherSubjectExec{Exec: string(s)}
	default:
		x.err = usage(fmt.Sprintf("c.Poll takes c, a reeval.File or a reeval.Command, which reeval "+
			"reads or runs again on each try (got %T): a value never changes", subject))
	}
	return x
}

func subjectOf(c *C, actual any) (wire.MatcherSubject, error) {
	switch a := actual.(type) {
	case *C:
		return wire.MatcherSubjectAttempt{}, nil
	case Turn:
		return wire.MatcherSubjectTurn{Turn: a.Index}, nil
	case *Turn:
		return wire.MatcherSubjectTurn{Turn: a.Index}, nil
	case ExecResult:
		return wire.MatcherSubjectExec{Exec: a.Command, Result: a.wire()}, nil
	case *ExecResult:
		return wire.MatcherSubjectExec{Exec: a.Command, Result: a.wire()}, nil
	case File:
		return wire.MatcherSubjectReadFile{ReadFile: string(a)}, nil
	case Command:
		return wire.MatcherSubjectExec{Exec: string(a)}, nil
	}
	v, err := jsonValue(actual, "c.Expect takes c, a Turn, an ExecResult, a File, a Command or a JSON value")
	if err != nil {
		return nil, err
	}
	return wire.MatcherSubjectValue{Value: v}, nil
}

func (x *Expectation) with(f func(*Expectation)) *Expectation {
	y := *x
	if x.poll != nil {
		p := *x.poll
		y.poll = &p
	}
	f(&y)
	return &y
}

// Not passes when the matcher that follows fails.
func (x *Expectation) Not() *Expectation { return x.with(func(y *Expectation) { y.not = !y.not }) }

// Soft makes a failure fail the attempt once the body is done, instead of ending the body.
func (x *Expectation) Soft() *Expectation { return x.with(func(y *Expectation) { y.soft = true }) }

// Named names the check in the record, instead of the matcher and its arguments.
func (x *Expectation) Named(label string) *Expectation {
	return x.with(func(y *Expectation) { y.label = label })
}

// Every is how long a [C.Poll] waits between tries (50ms unless set).
func (x *Expectation) Every(d time.Duration) *Expectation {
	return x.polled("Every", func(p *wire.AttemptCallExpectPoll) { p.Interval = ms(d) })
}

// Within is how long a [C.Poll] keeps trying (1s unless set).
func (x *Expectation) Within(d time.Duration) *Expectation {
	return x.polled("Within", func(p *wire.AttemptCallExpectPoll) { p.Timeout = ms(d) })
}

func (x *Expectation) polled(method string, f func(*wire.AttemptCallExpectPoll)) *Expectation {
	return x.with(func(y *Expectation) {
		if y.poll == nil {
			if y.err == nil {
				y.err = usage(method + " is for c.Poll, which retries; c.Expect checks once")
			}
			return
		}
		f(y.poll)
	})
}

// ms is d in reeval's milliseconds, at least 1 so a tiny duration isn't read as unset.
func ms(d time.Duration) float64 { return math.Max(1, float64(d.Milliseconds())) }

// ToBe: the subject is want, as JavaScript's Object.is compares them (numbers and strings by
// value).
func (x *Expectation) ToBe(want any) bool { return x.check("toBe", want) }

// ToEqual: the subject deeply equals want, as JSON.
func (x *Expectation) ToEqual(want any) bool { return x.check("toEqual", want) }

// ToBeNull: the subject is JSON null, such as a nil value.
func (x *Expectation) ToBeNull() bool { return x.check("toBeNull") }

// ToBeTruthy: the subject is truthy, as JavaScript reads it (not false, 0, "" or null).
func (x *Expectation) ToBeTruthy() bool { return x.check("toBeTruthy") }

// ToContain: the subject string or list contains needle.
func (x *Expectation) ToContain(needle any) bool { return x.check("toContain", needle) }

// ToHaveFile: the workspace has the file, with contents matching pattern when one is given (a
// string it contains, a *regexp.Regexp or a [JSRegexp]).
func (x *Expectation) ToHaveFile(path string, pattern ...any) bool {
	return x.check("toHaveFile", append([]any{path}, pattern...)...)
}

// ToSucceed: the command exits 0.
func (x *Expectation) ToSucceed() bool { return x.check("toSucceed") }

// ToHaveSearched: the agent searched the web, for query when one is given.
func (x *Expectation) ToHaveSearched(query ...any) bool { return x.check("toHaveSearched", query...) }

// ToHaveFetched: the agent fetched a URL, matching url when one is given.
func (x *Expectation) ToHaveFetched(url ...any) bool { return x.check("toHaveFetched", url...) }

// ToHaveCalledSkill: the agent used the skill.
func (x *Expectation) ToHaveCalledSkill(name string) bool { return x.check("toHaveCalledSkill", name) }

// ToHaveCalledMCP: the agent called the MCP server's tool, with input matching when given.
func (x *Expectation) ToHaveCalledMCP(server, tool string, input ...any) bool {
	return x.check("toHaveCalledMcp", append([]any{server, tool}, input...)...)
}

// ToHaveCalledTool: the agent called a tool by its name (or a pattern), with input matching when
// given.
func (x *Expectation) ToHaveCalledTool(name any, input ...any) bool {
	return x.check("toHaveCalledTool", append([]any{name}, input...)...)
}

// ToHaveRun: the agent ran a command, matching command when one is given.
func (x *Expectation) ToHaveRun(command ...any) bool { return x.check("toHaveRun", command...) }

// ToHaveEdited: the agent edited a file, matching path when one is given.
func (x *Expectation) ToHaveEdited(path ...any) bool { return x.check("toHaveEdited", path...) }

// ToHaveChanged: the workspace's diff has a change, to paths (a pattern or a list of them) when
// given.
func (x *Expectation) ToHaveChanged(paths ...any) bool { return x.check("toHaveChanged", paths...) }

// ToPass: the judge's verdict passed.
func (x *Expectation) ToPass() bool { return x.check("toPass") }

// check runs a matcher and ends the body on a failure that isn't soft, or on reeval refusing it.
func (x *Expectation) check(matcher string, args ...any) bool {
	err := x.Matcher(matcher, args...)
	if err == nil {
		return true
	}
	var failed *AssertionError
	if errors.As(err, &failed) && x.soft {
		return false
	}
	x.c.stop(err)
	return false
}

// Matcher runs one of reeval's matchers by its name, such as one a newer reeval has that this SDK
// has no method for yet. It returns the failure, an *AssertionError, instead of ending the body,
// and reeval refusing the call as a *CallError.
func (x *Expectation) Matcher(name string, args ...any) error {
	if x.err != nil {
		return x.err
	}
	patterns := map[string]*goPattern{}
	wireArgs := make([]any, len(args))
	for i, a := range args {
		wireArgs[i] = argOf(a, patterns)
	}
	call := wire.AttemptCallExpect{
		Subject: x.subject, Matcher: name, Args: wireArgs, Not: x.not, Soft: x.soft, Label: x.label,
		Poll: x.poll,
	}
	r, err := x.c.a.call(x.ctx, call)
	// reeval asks for the strings it tested Go's patterns on; each round answers more. A subject
	// that changes on every read never runs out of new strings, so the rounds stop.
	for round := 0; err == nil && r.Untested != nil; round++ {
		if round == patternRounds {
			names := make([]string, 0, len(r.Untested))
			for key := range r.Untested {
				names = append(names, key)
			}
			sort.Strings(names)
			return &CallError{Op: "expect", Name: "UsageError", Message: fmt.Sprintf(
				"%s's subject changed while reeval matched %s on it, %d times over: check it once it "+
					"has stopped changing", name, strings.Join(names, ", "), patternRounds)}
		}
		for key, tested := range r.Untested {
			p, ok := patterns[key]
			if !ok {
				return fmt.Errorf("reeval asked about pattern %s, which this call didn't send", key)
			}
			for _, s := range tested {
				p.answers[s] = p.re.MatchString(s)
			}
		}
		r, err = x.c.a.call(x.ctx, call)
	}
	if err != nil {
		return err
	}
	if r.Assertion != nil && r.Assertion.Status == "fail" {
		message := r.Assertion.Message
		if message == "" {
			message = "expect failed"
		}
		return &AssertionError{Message: message}
	}
	return nil
}

// JSRegexp is a JavaScript regular expression, which reeval compiles itself: for a pattern that
// needs JavaScript's syntax. A *regexp.Regexp works anywhere a pattern does, and is matched here
// with Go's.
func JSRegexp(source, flags string) any { return wire.Pattern{Regexp: source, Flags: flags} }

// goPattern is a Go regexp on the wire: reeval sends back the strings it tested, and the
// answers go with the call when it's made again.
// patternRounds is how many times a call answers reeval's untested strings before giving up.
const patternRounds = 5

type goPattern struct {
	re      *regexp.Regexp
	answers map[string]bool
}

func argOf(v any, patterns map[string]*goPattern) any {
	if re, ok := v.(*regexp.Regexp); ok {
		key := re.String()
		p := patterns[key]
		if p == nil {
			p = &goPattern{re: re, answers: map[string]bool{}}
			patterns[key] = p
		}
		return patternArg{p: p, key: key}
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Slice, reflect.Array:
		if rv.Kind() == reflect.Slice && (rv.IsNil() || rv.Type().Elem().Kind() == reflect.Uint8) {
			return v
		}
		out := make([]any, rv.Len())
		for i := range out {
			out[i] = argOf(rv.Index(i).Interface(), patterns)
		}
		return out
	case reflect.Map:
		if rv.IsNil() || rv.Type().Key().Kind() != reflect.String {
			return v
		}
		out := make(map[string]any, rv.Len())
		for it := rv.MapRange(); it.Next(); {
			out[it.Key().String()] = argOf(it.Value().Interface(), patterns)
		}
		return out
	}
	return v
}

type patternArg struct {
	p   *goPattern
	key string
}

func (a patternArg) MarshalJSON() ([]byte, error) {
	return json.Marshal(wire.AnsweredPattern{MatchedBy: a.key, Answers: a.p.answers})
}
