package reeval

import (
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"

	"github.com/invertase/reeval/sdks/go/internal/wire"
)

// Options are an eval's or a group's settings. A group's apply to everything in it, and reeval
// checks them all when it plans the run. A zero field is unset and inherits.
type Options struct {
	// Timeout is per attempt.
	Timeout time.Duration
	// Runs is the number of attempts per cell.
	Runs int
	// Tags select evals with --tag and profiles; a group's are added to its evals'.
	Tags []string
	// Environment is what the eval runs in, and the control of a Compare without a Baseline.
	Environment *Environment
	// Compare runs environments side by side and reports the lift.
	Compare *Compare
	// Egress replaces the inherited network policy.
	Egress Egress
	// Harness is the agent that runs the eval.
	Harness *HarnessDescriptor
	// Sandbox is the machine, when the environment doesn't name one.
	Sandbox *SandboxDescriptor
	// Env holds variables for the sandbox, merged by name down the cascade.
	Env map[string]string
	// Pin lists the keys a profile's limit may not narrow.
	Pin []string
	// Extra holds options this struct doesn't name yet, by reeval's own key (`judge`, `gate`, …).
	Extra map[string]any
}

func (o Options) apply(s *settings) { s.options = o }

func (o Options) wire() map[string]any {
	out := maps.Clone(o.Extra)
	if out == nil {
		out = map[string]any{}
	}
	if o.Timeout != 0 {
		out["timeout"] = duration(o.Timeout)
	}
	if o.Runs != 0 {
		out["runs"] = o.Runs
	}
	if o.Tags != nil {
		out["tags"] = slices.Clone(o.Tags)
	}
	if o.Environment != nil {
		out["environment"] = o.Environment.wire()
	}
	if o.Compare != nil {
		out["compare"] = o.Compare.wire()
	}
	if o.Egress != nil {
		out["egress"] = o.Egress.egress()
	}
	if o.Harness != nil {
		out["harness"] = o.Harness.wire()
	}
	if o.Sandbox != nil {
		out["sandbox"] = o.Sandbox.wire()
	}
	if o.Env != nil {
		out["env"] = maps.Clone(o.Env)
	}
	if o.Pin != nil {
		out["pin"] = slices.Clone(o.Pin)
	}
	return out
}

// duration is how reeval spells a time.Duration: whole hours, minutes or seconds, else
// milliseconds.
func duration(d time.Duration) any {
	for _, unit := range []struct {
		d      time.Duration
		suffix string
	}{{time.Hour, "h"}, {time.Minute, "m"}, {time.Second, "s"}} {
		if d%unit.d == 0 {
			return fmt.Sprintf("%d%s", d/unit.d, unit.suffix)
		}
	}
	return d.Milliseconds()
}

// Compare runs the eval in each variant beside the control and reports each variant's lift.
type Compare struct {
	// Baseline is the control; without one, the eval's Environment is.
	Baseline *Environment
	Variants []*Environment
	// Questions are asked of the control and each variant side by side.
	Questions []Question
	// Gate is how each cell's attempts decide its outcome, e.g. "all".
	Gate string
	// MinLift is the least lift, by its interval's lower bound, a variant must show.
	MinLift float64
}

func (c *Compare) wire() map[string]any {
	out := map[string]any{}
	if c.Baseline != nil {
		out["baseline"] = c.Baseline.wire()
	}
	if c.Variants != nil {
		variants := make([]any, len(c.Variants))
		for i, v := range c.Variants {
			variants[i] = v.wire()
		}
		out["variants"] = variants
	}
	if c.Questions != nil {
		questions := make([]any, len(c.Questions))
		for i, q := range c.Questions {
			questions[i] = q.wire()
		}
		out["questions"] = questions
	}
	if c.Gate != "" {
		out["gate"] = c.Gate
	}
	if c.MinLift != 0 {
		out["minLift"] = c.MinLift
	}
	return out
}

// Question is a pairwise question for a Compare; Model, a "provider/model", answers it instead of
// the default.
type Question struct {
	Text  string
	Model string
}

func (q Question) wire() any {
	if q.Model == "" {
		return q.Text
	}
	return wire.CompareQuestionQuestion{Question: q.Text, Model: q.Model}
}

// Egress is a network policy: [EgressProxy], [EgressAllowAll], [EgressDenyAll] or an
// [EgressAllow] list.
type Egress interface{ egress() any }

// EgressMode is one of reeval's named policies.
type EgressMode string

const (
	// EgressProxy sends any HTTP(S) host through the egress gateway; it's the default.
	EgressProxy EgressMode = "proxy"
	// EgressAllowAll lets the sandbox connect anywhere, raw TCP and UDP included.
	EgressAllowAll EgressMode = "allow-all"
	// EgressDenyAll lets it connect nowhere but reeval's own hosts.
	EgressDenyAll EgressMode = "deny-all"
)

func (m EgressMode) egress() any { return string(m) }

// EgressAllow lets the sandbox reach these hosts only (`*.example.com` matches subdomains).
type EgressAllow []string

func (a EgressAllow) egress() any { return map[string]any{"allow": slices.Clone([]string(a))} }

// DefaultEgressAllow is the package registries and code hosts an install step needs, for an
// allow list that adds to them: append(reeval.DefaultEgressAllow(), "api.example.com").
func DefaultEgressAllow() EgressAllow {
	return EgressAllow{
		"registry.npmjs.org",
		"registry.yarnpkg.com",
		"github.com",
		"*.github.com",
		"*.githubusercontent.com",
		"pypi.org",
		"files.pythonhosted.org",
	}
}

// Environment is a named environment: its own Spec on top of the environments it extends.
type Environment struct {
	name   string
	layers []layer
}

type layer struct {
	name string
	spec map[string]any
}

// DefineEnvironment is an environment to run evals in: sandbox, files, setup, plugins, egress
// and env. The spec is copied, so changing it later doesn't change the environment.
func DefineEnvironment(name string, spec Spec) *Environment {
	return &Environment{name: name, layers: []layer{{name, spec.wire()}}}
}

// Extend is a child environment: its spec replaces this one's, key by key.
func (e *Environment) Extend(name string, spec Spec) *Environment {
	return &Environment{name: name, layers: append(slices.Clone(e.layers), layer{name, spec.wire()})}
}

// Name is the name the environment was defined or extended under, which names its cells.
func (e *Environment) Name() string { return e.name }

func (e *Environment) wire() map[string]any {
	layers := make([]any, len(e.layers))
	for i, l := range e.layers {
		layers[i] = map[string]any{"name": l.name, "spec": l.spec}
	}
	return map[string]any{"kind": "environment", "name": e.name, "layers": layers}
}

// Spec is what an environment sets. A zero field is unset.
type Spec struct {
	Sandbox *SandboxDescriptor
	Env     map[string]string
	Egress  Egress
	Plugins []Plugin
	// Files are written into the workspace, by workspace-relative path or `~/`.
	Files map[string]string
	// Setup commands run in every attempt before the agent starts.
	Setup []string
	// Rules are project rules, written where the harness's agent reads them.
	Rules string
	// Extra holds spec keys this struct doesn't name yet (`skills`, `mcp`, `workspace`, …).
	Extra map[string]any
}

func (s Spec) wire() map[string]any {
	out := deepCopy(s.Extra)
	if out == nil {
		out = map[string]any{}
	}
	if s.Sandbox != nil {
		out["sandbox"] = s.Sandbox.wire()
	}
	if s.Env != nil {
		out["env"] = maps.Clone(s.Env)
	}
	if s.Egress != nil {
		out["egress"] = s.Egress.egress()
	}
	if s.Plugins != nil {
		plugins := make([]any, len(s.Plugins))
		for i, p := range s.Plugins {
			plugins[i] = maps.Clone(p.fields)
		}
		out["plugins"] = plugins
	}
	if s.Files != nil {
		out["files"] = maps.Clone(s.Files)
	}
	if s.Setup != nil {
		out["setup"] = slices.Clone(s.Setup)
	}
	if s.Rules != "" {
		out["rules"] = s.Rules
	}
	return out
}

func deepCopy(m map[string]any) map[string]any {
	if m == nil {
		return nil
	}
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = deepValue(v)
	}
	return out
}

func deepValue(v any) any {
	switch v := v.(type) {
	case map[string]any:
		return deepCopy(v)
	case []any:
		out := make([]any, len(v))
		for i, x := range v {
			out[i] = deepValue(x)
		}
		return out
	default:
		return v
	}
}

// SandboxDescriptor is where an attempt runs: [Docker] or [FakeSandbox].
type SandboxDescriptor struct{ fields map[string]any }

func (d *SandboxDescriptor) wire() map[string]any { return deepCopy(d.fields) }

// DockerOptions configure reeval's Docker sandbox. A zero field keeps reeval's default.
type DockerOptions struct {
	// From is a Debian or Ubuntu based image reeval bakes Node and the harness onto.
	From string
	// Dockerfile builds the image instead, relative to reeval.yml.
	Dockerfile string
	// Install commands become a layer on the image.
	Install []string
	Extra   map[string]any
}

// Docker is reeval's Docker sandbox.
func Docker(o DockerOptions) *SandboxDescriptor {
	fields := deepCopy(o.Extra)
	if fields == nil {
		fields = map[string]any{}
	}
	fields["kind"] = "docker"
	if o.From != "" {
		fields["from"] = o.From
	}
	if o.Dockerfile != "" {
		fields["dockerfile"] = o.Dockerfile
	}
	if o.Install != nil {
		fields["install"] = slices.Clone(o.Install)
	}
	return &SandboxDescriptor{fields}
}

// FakeSandbox runs the attempt in a temporary directory on the host, for evals that need no
// container.
func FakeSandbox() *SandboxDescriptor {
	return &SandboxDescriptor{map[string]any{"kind": "fake"}}
}

// HarnessDescriptor is the agent an attempt runs. reeval.yml usually names it; an eval sets one
// to run under another agent.
type HarnessDescriptor struct{ fields map[string]any }

func (d *HarnessDescriptor) wire() map[string]any { return deepCopy(d.fields) }

// Harness is a harness by reeval's kind (`cursor`, `claude-code`, `codex`, …) and its options
// by reeval's keys.
func Harness(kind string, options map[string]any) *HarnessDescriptor {
	fields := deepCopy(options)
	if fields == nil {
		fields = map[string]any{}
	}
	fields["kind"] = kind
	return &HarnessDescriptor{fields}
}

// FakeHarnessOptions configure the fake agent.
type FakeHarnessOptions struct {
	// Layout makes it look like a real harness (`claude-code`, …) for egress and rules.
	Layout string
	Extra  map[string]any
}

// FakeHarness is the fake agent, for evals that run without a real one.
func FakeHarness(o FakeHarnessOptions) *HarnessDescriptor {
	d := Harness("fake", o.Extra)
	if o.Layout != "" {
		d.fields["layout"] = o.Layout
	}
	return d
}

// Plugin is an agent plugin an environment installs.
type Plugin struct{ fields map[string]any }

// PluginOptions narrow and build a plugin. A zero field is unset.
type PluginOptions struct {
	// Ref is a git branch, tag or commit.
	Ref string
	// Path is the plugin's directory inside its source.
	Path string
	// Only installs these parts (`skills`, `agents`, …).
	Only  []string
	Build *Build
}

// Build is a plugin's build commands, run in order from Cwd (relative to its source) instead of
// its directory.
type Build struct {
	Run []string
	Cwd string
}

func (b *Build) wire() any {
	if b.Cwd != "" {
		return map[string]any{"run": slices.Clone(b.Run), "cwd": b.Cwd}
	}
	if len(b.Run) == 1 {
		return b.Run[0]
	}
	return slices.Clone(b.Run)
}

func plugin(source string, o PluginOptions, fields map[string]any) Plugin {
	fields["kind"] = "plugin"
	fields["source"] = source
	if o.Ref != "" {
		fields["ref"] = o.Ref
	}
	if o.Path != "" {
		fields["path"] = o.Path
	}
	if o.Only != nil {
		fields["only"] = slices.Clone(o.Only)
	}
	if o.Build != nil {
		fields["build"] = o.Build.wire()
	}
	return Plugin{fields}
}

// PluginLocal is a plugin in a directory, relative to reeval.yml.
func PluginLocal(path string, o PluginOptions) Plugin {
	o.Path = ""
	return plugin("local", o, map[string]any{"path": path})
}

// PluginGit is a plugin from a git repository (`github:acme/agent-plugins` or a URL).
func PluginGit(repo string, o PluginOptions) Plugin {
	return plugin("git", o, map[string]any{"repo": repo})
}

// PluginNPM is a plugin from an npm package spec (`@acme/review-plugin@1.2.0`).
func PluginNPM(spec string, o PluginOptions) Plugin {
	return plugin("npm", o, map[string]any{"spec": spec})
}

// PluginMarketplace is an entry of a plugin marketplace, `name@source`: a git marketplace
// (`lint@github:acme/agent-plugins`) or an npm one (`format@npm:@acme/plugins@2.0.0`). It panics
// on a malformed entry, which fails the eval file when reeval loads it.
func PluginMarketplace(entry string, o PluginOptions) Plugin {
	name, source, ok := strings.Cut(entry, "@")
	source = strings.TrimSpace(source)
	if name == "" || !ok || source == "" {
		panic(fmt.Sprintf("reeval.PluginMarketplace needs \"name@source\", e.g. "+
			"\"lint@github:acme/agent-plugins\" (got %q)", entry))
	}
	var market map[string]any
	if spec, isNPM := strings.CutPrefix(source, "npm:"); isNPM {
		if o.Ref != "" {
			panic(fmt.Sprintf("reeval.PluginMarketplace(%q): Ref picks a commit of a git "+
				"marketplace; pin an npm marketplace in its spec, e.g. npm:@acme/plugins@2.0.0", entry))
		}
		market = map[string]any{"source": "npm", "spec": spec}
	} else {
		market = map[string]any{"source": "git", "repo": source}
		if o.Ref != "" {
			market["ref"] = o.Ref
		}
	}
	o.Ref, o.Path = "", ""
	return plugin("marketplace", o, map[string]any{"name": name, "marketplace": market})
}

// JudgeModel is the model that answers a judge's question: [Model] or [FakeJudge].
type JudgeModel struct {
	id   string
	fake *float64
}

// Model is a judge model by its "provider/model" id.
func Model(id string) JudgeModel { return JudgeModel{id: id} }

// FakeJudge is a judge with a fixed score, for evals that run without a model.
func FakeJudge(score float64) JudgeModel { return JudgeModel{fake: &score} }

func (m JudgeModel) wire() any {
	if m.fake != nil {
		return wire.FakeJudgeData{Score: *m.fake}
	}
	if m.id != "" {
		return m.id
	}
	return nil
}
