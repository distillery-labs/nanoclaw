package service

import (
	"strings"
	"testing"
)

func TestPlistTemplate(t *testing.T) {
	data := tmplData{
		Name:       "my-runner",
		BinaryPath: "/usr/local/bin/nanoclaw-runner",
		Env: []envEntry{
			{Key: "NANOCLAW_CENTRAL_URL", Value: "wss://example.com/runner/connect"},
			{Key: "NANOCLAW_RUNNER_NAME", Value: "my-runner"},
		},
	}
	var buf strings.Builder
	if err := plistTmpl.Execute(&buf, data); err != nil {
		t.Fatalf("plist template error: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "com.nanoclaw.runner.my-runner") {
		t.Error("plist missing label")
	}
	if !strings.Contains(out, "/usr/local/bin/nanoclaw-runner") {
		t.Error("plist missing binary path")
	}
	if !strings.Contains(out, "NANOCLAW_CENTRAL_URL") {
		t.Error("plist missing env key")
	}
	if !strings.Contains(out, "wss://example.com/runner/connect") {
		t.Error("plist missing env value")
	}
	if strings.Contains(out, "NANOCLAW_RUNNER_BOOTSTRAP") {
		t.Error("plist must not contain bootstrap token key")
	}
}

func TestUnitTemplate(t *testing.T) {
	data := tmplData{
		Name:       "my-runner",
		BinaryPath: "/usr/local/bin/nanoclaw-runner",
		Env: []envEntry{
			{Key: "NANOCLAW_CENTRAL_URL", Value: "wss://example.com/runner/connect"},
			{Key: "NANOCLAW_RUNNER_NAME", Value: "my-runner"},
		},
	}
	var buf strings.Builder
	if err := unitTmpl.Execute(&buf, data); err != nil {
		t.Fatalf("unit template error: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "NanoClaw runner (my-runner)") {
		t.Error("unit missing description")
	}
	if !strings.Contains(out, "/usr/local/bin/nanoclaw-runner") {
		t.Error("unit missing binary path")
	}
	if !strings.Contains(out, "Environment=NANOCLAW_CENTRAL_URL=") {
		t.Error("unit missing env entry")
	}
	if strings.Contains(out, "NANOCLAW_RUNNER_BOOTSTRAP") {
		t.Error("unit must not contain bootstrap token key")
	}
}

func TestCollectEnv_ExcludesBootstrap(t *testing.T) {
	t.Setenv("NANOCLAW_RUNNER_BOOTSTRAP", "secret-token")
	t.Setenv("NANOCLAW_RUNNER_NAME", "test-runner")

	entries := collectEnv()
	for _, e := range entries {
		if e.Key == "NANOCLAW_RUNNER_BOOTSTRAP" {
			t.Error("collectEnv must not include NANOCLAW_RUNNER_BOOTSTRAP")
		}
	}
}

func TestCollectEnv_IncludesPresent(t *testing.T) {
	t.Setenv("NANOCLAW_CENTRAL_URL", "wss://test.example.com")
	t.Setenv("NANOCLAW_RUNNER_NAME", "test")

	entries := collectEnv()
	found := false
	for _, e := range entries {
		if e.Key == "NANOCLAW_CENTRAL_URL" {
			found = true
			if e.Value != "wss://test.example.com" {
				t.Errorf("unexpected value: %q", e.Value)
			}
		}
	}
	if !found {
		t.Error("NANOCLAW_CENTRAL_URL should be included when set")
	}
}

func TestEscapeEnvValue(t *testing.T) {
	cases := []struct{ in, want string }{
		{"plain", "plain"},
		{"a&b", "a&amp;b"},
		{"<tag>", "&lt;tag&gt;"},
		{`say "hi"`, `say &quot;hi&quot;`},
	}
	for _, c := range cases {
		got := escapeEnvValue(c.in)
		if got != c.want {
			t.Errorf("escapeEnvValue(%q) = %q; want %q", c.in, got, c.want)
		}
	}
}
