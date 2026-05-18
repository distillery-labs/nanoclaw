// Package service installs and uninstalls nanoclaw-runner as a system service.
// On macOS it writes a launchd plist; on Linux a systemd user unit.
package service

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"text/template"
)

// envKeys are the env vars captured at install time and embedded in the service file.
// NANOCLAW_RUNNER_BOOTSTRAP is intentionally excluded — it is single-use and already consumed.
var envKeys = []string{
	"NANOCLAW_CENTRAL_URL",
	"NANOCLAW_RUNNER_NAME",
	"NANOCLAW_RUNNER_TYPE",
	"NANOCLAW_RUNNER_VERSION",
	"NANOCLAW_HEARTBEAT_INTERVAL_SEC",
	"NANOCLAW_RECONNECT_BASE_DELAY_SEC",
	"NANOCLAW_RECONNECT_MAX_DELAY_SEC",
	"NANOCLAW_RUNNER_AUTO_UPDATE",
	"NANOCLAW_RUNNER_UPDATE_INTERVAL",
	"NANOCLAW_RUNNER_ROTATION_INTERVAL",
	"NANOCLAW_RUNNER_CREDENTIAL_DIR",
}

// Install writes the service file and registers it with the platform service manager.
// If force is false and a service file already exists, Install returns an error rather
// than silently overwriting. Pass force=true to unload/stop, overwrite, and reload.
func Install(force bool) error {
	name := os.Getenv("NANOCLAW_RUNNER_NAME")
	if name == "" {
		return fmt.Errorf("NANOCLAW_RUNNER_NAME is required for install")
	}

	binaryPath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot determine binary path: %w", err)
	}
	binaryPath, err = filepath.Abs(binaryPath)
	if err != nil {
		return fmt.Errorf("cannot resolve binary path: %w", err)
	}

	env := collectEnv()

	switch runtime.GOOS {
	case "darwin":
		return installDarwin(name, binaryPath, env, force)
	case "linux":
		return installLinux(name, binaryPath, env, force)
	default:
		return fmt.Errorf("unsupported platform: %s; install the service manually", runtime.GOOS)
	}
}

// Uninstall stops and removes the service.
func Uninstall() error {
	name := os.Getenv("NANOCLAW_RUNNER_NAME")
	if name == "" {
		return fmt.Errorf("NANOCLAW_RUNNER_NAME is required for uninstall")
	}

	switch runtime.GOOS {
	case "darwin":
		return uninstallDarwin(name)
	case "linux":
		return uninstallLinux(name)
	default:
		return fmt.Errorf("unsupported platform: %s", runtime.GOOS)
	}
}

// ── macOS launchd ─────────────────────────────────────────────────────────────

var plistTmpl = template.Must(template.New("plist").Parse(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.nanoclaw.runner.{{.Name}}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{{.BinaryPath}}</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
{{- range .Env}}
		<key>{{.Key}}</key>
		<string>{{.Value}}</string>
{{- end}}
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>/tmp/nanoclaw-runner-{{.Name}}.log</string>
	<key>StandardErrorPath</key>
	<string>/tmp/nanoclaw-runner-{{.Name}}.error.log</string>
</dict>
</plist>
`))

type tmplData struct {
	Name       string
	BinaryPath string
	Env        []envEntry
}

type envEntry struct {
	Key   string
	Value string
}

func plistPath(name string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot determine home dir: %w", err)
	}
	return filepath.Join(home, "Library", "LaunchAgents",
		fmt.Sprintf("com.nanoclaw.runner.%s.plist", name)), nil
}

func installDarwin(name, binaryPath string, env []envEntry, force bool) error {
	path, err := plistPath(name)
	if err != nil {
		return err
	}

	if _, statErr := os.Stat(path); statErr == nil {
		if !force {
			return fmt.Errorf("service file already exists: %s\n"+
				"  Run with --force to unload, overwrite, and reload", path)
		}
		if out, err := exec.Command("launchctl", "unload", path).CombinedOutput(); err != nil {
			fmt.Printf("nanoclaw-runner: warning: launchctl unload (pre-reinstall): %v\n%s\n", err, out)
		} else {
			fmt.Printf("nanoclaw-runner: unloaded existing service before reinstall\n")
		}
	}

	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
	}

	var buf bytes.Buffer
	if err := plistTmpl.Execute(&buf, tmplData{Name: name, BinaryPath: binaryPath, Env: env}); err != nil {
		return fmt.Errorf("render plist: %w", err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0644); err != nil {
		return fmt.Errorf("write plist: %w", err)
	}
	fmt.Printf("nanoclaw-runner: wrote %s\n", path)

	if out, err := exec.Command("launchctl", "load", path).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl load: %w\n%s", err, out)
	}
	fmt.Printf("nanoclaw-runner: service loaded — com.nanoclaw.runner.%s\n", name)

	out, _ := exec.Command("launchctl", "list", fmt.Sprintf("com.nanoclaw.runner.%s", name)).CombinedOutput()
	fmt.Printf("%s\n", out)
	return nil
}

func uninstallDarwin(name string) error {
	label := fmt.Sprintf("com.nanoclaw.runner.%s", name)
	path, err := plistPath(name)
	if err != nil {
		return err
	}

	if _, statErr := os.Stat(path); os.IsNotExist(statErr) {
		return fmt.Errorf("service not found: %s", path)
	}

	if out, err := exec.Command("launchctl", "unload", path).CombinedOutput(); err != nil {
		fmt.Printf("nanoclaw-runner: warning: launchctl unload: %v\n%s\n", err, out)
	} else {
		fmt.Printf("nanoclaw-runner: service unloaded — %s\n", label)
	}

	if err := os.Remove(path); err != nil {
		return fmt.Errorf("remove plist: %w", err)
	}
	fmt.Printf("nanoclaw-runner: removed %s\n", path)
	return nil
}

// ── Linux systemd ─────────────────────────────────────────────────────────────

var unitTmpl = template.Must(template.New("unit").Parse(`[Unit]
Description=NanoClaw runner ({{.Name}})
After=network.target

[Service]
ExecStart={{.BinaryPath}}
{{- range .Env}}
Environment={{.Key}}={{.Value}}
{{- end}}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`))

func unitPath(name string) (string, error) {
	configDir := os.Getenv("XDG_CONFIG_HOME")
	if configDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("cannot determine home dir: %w", err)
		}
		configDir = filepath.Join(home, ".config")
	}
	return filepath.Join(configDir, "systemd", "user",
		fmt.Sprintf("nanoclaw-runner-%s.service", name)), nil
}

func installLinux(name, binaryPath string, env []envEntry, force bool) error {
	path, err := unitPath(name)
	if err != nil {
		return err
	}

	if _, statErr := os.Stat(path); statErr == nil {
		if !force {
			return fmt.Errorf("service file already exists: %s\n"+
				"  Run with --force to stop, overwrite, and re-enable", path)
		}
		unitName := fmt.Sprintf("nanoclaw-runner-%s.service", name)
		if out, err := exec.Command("systemctl", "--user", "disable", "--now", unitName).CombinedOutput(); err != nil {
			fmt.Printf("nanoclaw-runner: warning: systemctl disable --now (pre-reinstall): %v\n%s\n", err, out)
		} else {
			fmt.Printf("nanoclaw-runner: stopped and disabled existing service before reinstall\n")
		}
	}

	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
	}

	var buf bytes.Buffer
	if err := unitTmpl.Execute(&buf, tmplData{Name: name, BinaryPath: binaryPath, Env: env}); err != nil {
		return fmt.Errorf("render unit: %w", err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0644); err != nil {
		return fmt.Errorf("write unit: %w", err)
	}
	fmt.Printf("nanoclaw-runner: wrote %s\n", path)

	if out, err := exec.Command("systemctl", "--user", "daemon-reload").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl daemon-reload: %w\n%s", err, out)
	}
	if out, err := exec.Command("systemctl", "--user", "enable", "--now",
		fmt.Sprintf("nanoclaw-runner-%s.service", name)).CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl enable --now: %w\n%s", err, out)
	}
	fmt.Printf("nanoclaw-runner: service enabled — nanoclaw-runner-%s.service\n", name)

	out, _ := exec.Command("systemctl", "--user", "status",
		fmt.Sprintf("nanoclaw-runner-%s.service", name)).CombinedOutput()
	fmt.Printf("%s\n", out)
	return nil
}

func uninstallLinux(name string) error {
	unitName := fmt.Sprintf("nanoclaw-runner-%s.service", name)
	path, err := unitPath(name)
	if err != nil {
		return err
	}

	if _, statErr := os.Stat(path); os.IsNotExist(statErr) {
		return fmt.Errorf("service not found: %s", path)
	}

	if out, err := exec.Command("systemctl", "--user", "disable", "--now", unitName).CombinedOutput(); err != nil {
		fmt.Printf("nanoclaw-runner: warning: systemctl disable --now: %v\n%s\n", err, out)
	} else {
		fmt.Printf("nanoclaw-runner: service disabled — %s\n", unitName)
	}

	if err := os.Remove(path); err != nil {
		return fmt.Errorf("remove unit file: %w", err)
	}
	if out, err := exec.Command("systemctl", "--user", "daemon-reload").CombinedOutput(); err != nil {
		fmt.Printf("nanoclaw-runner: warning: daemon-reload after uninstall: %v\n%s\n", err, out)
	}
	fmt.Printf("nanoclaw-runner: removed %s\n", path)
	return nil
}

// ── helpers ───────────────────────────────────────────────────────────────────

func collectEnv() []envEntry {
	var entries []envEntry
	for _, k := range envKeys {
		v := os.Getenv(k)
		if v != "" {
			entries = append(entries, envEntry{Key: k, Value: escapeEnvValue(v)})
		}
	}
	return entries
}

// escapeEnvValue escapes a value for safe embedding in service files.
// Handles common special characters that would break plist XML or systemd unit syntax.
func escapeEnvValue(v string) string {
	v = strings.ReplaceAll(v, "&", "&amp;")
	v = strings.ReplaceAll(v, "<", "&lt;")
	v = strings.ReplaceAll(v, ">", "&gt;")
	v = strings.ReplaceAll(v, "\"", "&quot;")
	return v
}
