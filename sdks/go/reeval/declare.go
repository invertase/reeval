package reeval

import (
	"context"
	"fmt"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"github.com/invertase/reeval/sdks/go/internal/wire"
)

// Body is an eval's body: one attempt of the eval, run by reeval against a real agent. It returns
// an error to fail the attempt, as a test helper would t.Fatal. ctx is cancelled when reeval gives
// up on the attempt.
type Body func(ctx context.Context, c *C) error

// Option is a setting for [E.Run], [E.Group] or [Each]: [Options], [Skip], [Only] or [Unpooled].
type Option interface{ apply(*settings) }

type settings struct {
	options  Options
	mode     wire.DeclaredMode
	unpooled bool
}

func settle(opts []Option) settings {
	s := settings{mode: wire.DeclaredModeRun}
	for _, o := range opts {
		if o != nil {
			o.apply(&s)
		}
	}
	return s
}

type optionFunc func(*settings)

func (f optionFunc) apply(s *settings) { f(s) }

// Skip lists the eval or group in the plan without running it.
func Skip() Option { return optionFunc(func(s *settings) { s.mode = wire.DeclaredModeSkip }) }

// Only runs this eval or group, and the others marked Only, in its file.
func Only() Option { return optionFunc(func(s *settings) { s.mode = wire.DeclaredModeOnly }) }

// Unpooled keeps the cases of an [Each] as separate evals, each with its own outcome, instead of
// one family whose cases pool their attempts.
func Unpooled() Option { return optionFunc(func(s *settings) { s.unpooled = true }) }

// E declares the evals of one EvalXxx function, the way *testing.T runs a test's subtests. An
// eval file's functions are found as go test finds tests: exported, named Eval or EvalXxx, in a
// file ending in _eval.go, taking a *reeval.E.
//
//	func EvalGreet(e *reeval.E) {
//		e.Run("writes greet.js", func(ctx context.Context, c *reeval.C) error { … })
//	}
//
// An E only declares: bodies run later, once reeval has planned the run. Its methods must be
// called while the function that got it runs, and not from other goroutines.
type E struct {
	col      *collector
	children *[]node
}

type node interface{ tree() map[string]any }

type evalNode struct {
	name    string
	mode    wire.DeclaredMode
	options Options
	body    string
	family  *wire.DeclaredFamily
}

func (n *evalNode) tree() map[string]any {
	out := map[string]any{
		"type": "eval", "name": n.name, "mode": string(n.mode),
		"options": n.options.wire(), "body": n.body,
	}
	if n.family != nil {
		out["family"] = *n.family
	}
	return out
}

type groupNode struct {
	name     string
	mode     wire.DeclaredMode
	options  Options
	children []node
}

func (n *groupNode) tree() map[string]any {
	return map[string]any{
		"type": "group", "name": n.name, "mode": string(n.mode),
		"options": n.options.wire(), "children": trees(n.children),
	}
}

type todoNode struct{ name string }

func (n *todoNode) tree() map[string]any { return map[string]any{"type": "todo", "name": n.name} }

func trees(nodes []node) []any {
	out := make([]any, len(nodes))
	for i, n := range nodes {
		out[i] = n.tree()
	}
	return out
}

// collector is one eval file's declaration: its tree and its bodies by id.
type collector struct {
	mu       sync.Mutex
	children []node
	bodies   map[string]Body
	closed   bool
}

func (col *collector) add(children *[]node, n node) {
	col.mu.Lock()
	defer col.mu.Unlock()
	if col.closed {
		panic("reeval: an eval was declared after its file was collected; call e.Run, e.Group, " +
			"e.Todo and reeval.Each while the EvalXxx function runs, not from a body or a goroutine")
	}
	*children = append(*children, n)
}

func (col *collector) body(b Body) string {
	col.mu.Lock()
	defer col.mu.Unlock()
	id := "b" + strconv.Itoa(len(col.bodies)+1)
	col.bodies[id] = b
	return id
}

// Run declares an eval: body runs once per attempt, in every cell of the eval's matrix.
func (e *E) Run(name string, body Body, opts ...Option) {
	if body == nil {
		panic(fmt.Sprintf("reeval: e.Run(%q) needs a body", name))
	}
	s := settle(opts)
	e.col.add(e.children, &evalNode{name: name, mode: s.mode, options: s.options, body: e.col.body(body)})
}

// Group declares a group: fn declares its evals and groups, which inherit its options.
func (e *E) Group(name string, fn func(e *E), opts ...Option) {
	s := settle(opts)
	g := &groupNode{name: name, mode: s.mode, options: s.options}
	e.col.add(e.children, g)
	fn(&E{col: e.col, children: &g.children})
}

// Todo lists an eval still to write in the plan; it never runs.
func (e *E) Todo(name string) { e.col.add(e.children, &todoNode{name: name}) }

// Each declares one eval per case, table-driven: body gets the case it runs. The cases are one
// family, whose attempts pool for its outcome and lift, unless [Unpooled] or there's only one.
//
// Each eval is named from name: `%#` is the case's index, `%s` the case as fmt's %v writes it,
// and `$field` the field of a struct case (by its Go name or its json tag) or a map case's key,
// left as written when the case has none.
func Each[T any](e *E, name string, cases []T, body func(ctx context.Context, c *C, tc T) error, opts ...Option) {
	if body == nil {
		panic(fmt.Sprintf("reeval.Each(%q) needs a body", name))
	}
	s := settle(opts)
	for i, tc := range cases {
		var family *wire.DeclaredFamily
		if !s.unpooled && len(cases) > 1 {
			family = &wire.DeclaredFamily{Name: name, Case: i, Cases: len(cases)}
		}
		id := e.col.body(func(ctx context.Context, c *C) error { return body(ctx, c, tc) })
		e.col.add(e.children, &evalNode{
			name: caseName(name, tc, i), mode: s.mode, options: s.options, body: id, family: family,
		})
	}
}

var placeholder = regexp.MustCompile(`%#|%s|\$([A-Za-z_][A-Za-z0-9_]*)`)

func caseName(template string, tc any, index int) string {
	return placeholder.ReplaceAllStringFunc(template, func(m string) string {
		switch m {
		case "%#":
			return strconv.Itoa(index)
		case "%s":
			return fmt.Sprint(tc)
		}
		if v, ok := field(tc, m[1:]); ok {
			return fmt.Sprint(v)
		}
		return m
	})
}

// field is a case's field by name: a map's key, or a struct's field by its json tag or Go name
// (`$n` finds `N`).
func field(tc any, name string) (any, bool) {
	v := reflect.ValueOf(tc)
	for v.Kind() == reflect.Pointer || v.Kind() == reflect.Interface {
		if v.IsNil() {
			return nil, false
		}
		v = v.Elem()
	}
	switch v.Kind() {
	case reflect.Map:
		if v.Type().Key().Kind() != reflect.String {
			return nil, false
		}
		got := v.MapIndex(reflect.ValueOf(name).Convert(v.Type().Key()))
		if !got.IsValid() {
			return nil, false
		}
		return got.Interface(), true
	case reflect.Struct:
		t := v.Type()
		for i := range t.NumField() {
			f := t.Field(i)
			if !f.IsExported() {
				continue
			}
			tag, _, _ := strings.Cut(f.Tag.Get("json"), ",")
			if tag == name || (tag == "" && f.Name == exported(name)) || f.Name == name {
				return v.Field(i).Interface(), true
			}
		}
	}
	return nil, false
}

func exported(name string) string {
	r, n := utf8.DecodeRuneInString(name)
	return string(unicode.ToUpper(r)) + name[n:]
}
