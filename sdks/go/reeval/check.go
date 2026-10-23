package reeval

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"github.com/invertase/reeval/sdks/go/internal/wire"
)

// subjectLimit is the longest a check's subject gets, on one line, before it's cut.
const subjectLimit = 200

// Assert checks cond, recording the check in the attempt whether it passes or fails, and ends the
// body when it's false, as t.Fatal does. The check is named by the expression as the eval wrote
// it: c.Assert(result.OK()) is "assert result.OK()". msg, as fmt.Sprint or (when the first is a
// format) fmt.Sprintf writes it, says why it failed.
func (c *C) Assert(cond bool, msg ...any) {
	if !c.assert("Assert", "assert", false, cond, "", msg) {
		c.stop(c.lastFailure())
	}
}

// Check is [C.Assert] that carries on: a false cond fails the attempt once the body is done, as
// t.Error does. It reports whether cond held.
func (c *C) Check(cond bool, msg ...any) bool {
	return c.assert("Check", "check", true, cond, "", msg)
}

// AssertEqual checks that got deeply equals want (reflect.DeepEqual), as [C.Assert] does, naming
// the check "assert got == want" from the arguments as written.
func (c *C) AssertEqual(got, want any, msg ...any) {
	if !c.assert("AssertEqual", "assert", false, reflect.DeepEqual(got, want), compared(got, want), msg) {
		c.stop(c.lastFailure())
	}
}

// CheckEqual is [C.AssertEqual] that carries on, as [C.Check] does.
func (c *C) CheckEqual(got, want any, msg ...any) bool {
	return c.assert("CheckEqual", "check", true, reflect.DeepEqual(got, want), compared(got, want), msg)
}

// Errorf records a failed check with the message and carries on; the attempt fails once the
// body is done.
func (c *C) Errorf(format string, args ...any) {
	message := fmt.Sprintf(format, args...)
	c.a.record(wire.AttemptCallRecord{Matcher: "errorf", Status: "fail", Message: message, Soft: true})
	c.failed(&AssertionError{Message: message}, true)
}

// Fatalf records a failed check with the message and ends the body.
func (c *C) Fatalf(format string, args ...any) {
	message := fmt.Sprintf(format, args...)
	c.a.record(wire.AttemptCallRecord{Matcher: "fatalf", Status: "fail", Message: message})
	c.stop(&AssertionError{Message: message})
}

// Helper marks the function that calls it as a check helper, as t.Helper does: a check it makes
// is named from its caller's source.
func (c *C) Helper() {
	pc, _, _, ok := runtime.Caller(1)
	if !ok {
		return
	}
	if fn := runtime.FuncForPC(pc); fn != nil {
		helpers.Store(fn.Name(), true)
	}
}

var helpers sync.Map

func (c *C) assert(method, matcher string, soft, ok bool, detail string, msg []any) bool {
	subject := callerSubject(method)
	call := wire.AttemptCallRecord{Matcher: matcher, Subject: subject, Status: "pass", Soft: soft}
	if ok {
		c.a.record(call)
		return true
	}
	if detail == "" {
		detail = subject
	}
	reason := matcher + " " + detail
	if extra := message(msg); extra != "" {
		reason = extra + ": " + reason
	}
	call.Status, call.Message = "fail", reason
	c.a.record(call)
	c.failed(&AssertionError{Message: reason}, soft)
	return false
}

func message(msg []any) string {
	if len(msg) == 0 {
		return ""
	}
	if format, ok := msg[0].(string); ok && len(msg) > 1 && strings.Contains(format, "%") {
		return fmt.Sprintf(format, msg[1:]...)
	}
	return fmt.Sprint(msg...)
}

// compared is a failed equality's values, as "1 == 2".
func compared(got, want any) string { return shown(got) + " == " + shown(want) }

func shown(v any) string {
	var text string
	if s, ok := v.(string); ok {
		text = strconv.Quote(s)
	} else {
		text = fmt.Sprintf("%+v", v)
	}
	if len(text) > subjectLimit {
		text = text[:subjectLimit] + "…"
	}
	return text
}

// failed notes a failure: the first one that isn't soft is what the body ended with.
func (c *C) failed(err error, soft bool) {
	if soft {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fatal == nil {
		c.fatal = err
	}
}

func (c *C) lastFailure() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.fatal
}

// stop ends the body's goroutine with err, as t.FailNow does; the runner reports err when the
// body is done.
func (c *C) stop(err error) {
	c.failed(err, false)
	runtime.Goexit()
}

const sdkPrefix = "github.com/invertase/reeval/sdks/go/reeval."

// callerSubject is the check's expression as the eval wrote it: the first argument of the
// method's call (both, for an equality) in the source of the first caller outside this package
// and its helpers.
func callerSubject(method string) string {
	pcs := make([]uintptr, 32)
	frames := runtime.CallersFrames(pcs[:runtime.Callers(2, pcs)])
	whole := false
	for {
		f, more := frames.Next()
		_, helper := helpers.Load(f.Function)
		if helper {
			// A helper's check is named by the helper's call, as its caller wrote it.
			method, whole = f.Function[strings.LastIndex(f.Function, ".")+1:], true
		}
		if !strings.HasPrefix(f.Function, sdkPrefix) && !helper {
			if s := sourceSubject(f.File, f.Line, method, whole); s != "" {
				return s
			}
			return fmt.Sprintf("%s:%d", filepath.Base(f.File), f.Line)
		}
		if !more {
			return strings.ToLower(method)
		}
	}
}

type source struct {
	fset *token.FileSet
	file *ast.File
	src  []byte
}

var sources sync.Map

func parsed(path string) *source {
	if s, ok := sources.Load(path); ok {
		return s.(*source)
	}
	src, err := os.ReadFile(path)
	if err != nil {
		sources.Store(path, (*source)(nil))
		return nil
	}
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, src, parser.SkipObjectResolution)
	if err != nil {
		sources.Store(path, (*source)(nil))
		return nil
	}
	s := &source{fset, file, src}
	sources.Store(path, s)
	return s
}

func sourceSubject(path string, line int, method string, whole bool) string {
	s := parsed(path)
	if s == nil {
		return ""
	}
	var found *ast.CallExpr
	ast.Inspect(s.file, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		start, end := s.fset.Position(call.Pos()).Line, s.fset.Position(call.End()).Line
		if calls(call, method) && start <= line && line <= end && (whole || len(call.Args) > 0) {
			found = call
		}
		return true
	})
	if found == nil {
		return ""
	}
	var text string
	switch {
	case whole:
		text = s.text(found)
	case strings.HasSuffix(method, "Equal") && len(found.Args) > 1:
		text = s.text(found.Args[0]) + " == " + s.text(found.Args[1])
	default:
		text = s.text(found.Args[0])
	}
	text = strings.Join(strings.Fields(text), " ")
	if len(text) > subjectLimit {
		text = text[:subjectLimit-1] + "…"
	}
	return text
}

func calls(call *ast.CallExpr, name string) bool {
	switch fn := call.Fun.(type) {
	case *ast.SelectorExpr:
		return fn.Sel.Name == name
	case *ast.Ident:
		return fn.Name == name
	}
	return false
}

func (s *source) text(n ast.Node) string {
	start, end := s.fset.Position(n.Pos()).Offset, s.fset.Position(n.End()).Offset
	return string(bytes.TrimSpace(s.src[start:end]))
}
