package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const DefaultPath = ".lmti/config.toml"

type Config struct {
	Project ProjectConfig
	Storage StorageConfig
	Publish PublishConfig
	Privacy PrivacyConfig
	Thoth   ThothConfig
	Agents  map[string]AgentConfig
}

type ProjectConfig struct {
	ID     string
	Name   string
	Layer  string
	Author string
}

type StorageConfig struct {
	Engine string
	Path   string
}

type PublishConfig struct {
	PublicRepo             string
	TargetBranch           string
	AllowedPublishBranches []string
}

type PrivacyConfig struct {
	Default          string
	BlockSecret     bool
	BlockDoNotPrompt bool
}

type ThothConfig struct {
	Enabled  bool
	Registry string
}

type AgentConfig struct {
	Enabled bool
}

func Default() Config {
	return Config{
		Project: ProjectConfig{ID: "lmti-atlas", Name: "LMTI Atlas", Layer: "independent", Author: "Edgar Vu - Cyno Software"},
		Storage: StorageConfig{Engine: "sqlite", Path: ".lmti/memory.sqlite"},
		Publish: PublishConfig{
			PublicRepo:             "https://github.com/vuthuanphat/lmti-atlas.git",
			TargetBranch:           "main",
			AllowedPublishBranches: []string{"main", "release/*", "publish/*"},
		},
		Privacy: PrivacyConfig{Default: "internal", BlockSecret: true, BlockDoNotPrompt: true},
		Thoth:   ThothConfig{Enabled: true, Registry: "skills/registry.toml"},
		Agents: map[string]AgentConfig{
			"codex":       {Enabled: true},
			"cursor":      {Enabled: true},
			"claude_code": {Enabled: true},
		},
	}
}

func Load(root string) (Config, error) {
	cfg := Default()
	path := filepath.Join(root, filepath.FromSlash(DefaultPath))
	content, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return cfg, err
	}
	if err := applyTOML(&cfg, string(content)); err != nil {
		return cfg, err
	}
	return cfg, nil
}

func Ensure(root string) (Config, bool, error) {
	cfg, err := Load(root)
	if err != nil {
		return cfg, false, err
	}
	path := filepath.Join(root, filepath.FromSlash(DefaultPath))
	if _, err := os.Stat(path); err == nil {
		return cfg, false, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return cfg, false, err
	}
	if err := os.WriteFile(path, []byte(ToTOML(cfg)), 0o600); err != nil {
		return cfg, false, err
	}
	return cfg, true, nil
}

func ToTOML(cfg Config) string {
	var builder strings.Builder
	fmt.Fprintf(&builder, "[project]\n")
	fmt.Fprintf(&builder, "id = %q\n", cfg.Project.ID)
	fmt.Fprintf(&builder, "name = %q\n", cfg.Project.Name)
	fmt.Fprintf(&builder, "layer = %q\n", cfg.Project.Layer)
	fmt.Fprintf(&builder, "author = %q\n\n", cfg.Project.Author)
	fmt.Fprintf(&builder, "[storage]\n")
	fmt.Fprintf(&builder, "engine = %q\n", cfg.Storage.Engine)
	fmt.Fprintf(&builder, "path = %q\n\n", cfg.Storage.Path)
	fmt.Fprintf(&builder, "[publish]\n")
	fmt.Fprintf(&builder, "public_repo = %q\n", cfg.Publish.PublicRepo)
	fmt.Fprintf(&builder, "target_branch = %q\n", cfg.Publish.TargetBranch)
	fmt.Fprintf(&builder, "allowed_publish_branches = [%s]\n\n", quoteArray(cfg.Publish.AllowedPublishBranches))
	fmt.Fprintf(&builder, "[privacy]\n")
	fmt.Fprintf(&builder, "default = %q\n", cfg.Privacy.Default)
	fmt.Fprintf(&builder, "block_secret_output = %t\n", cfg.Privacy.BlockSecret)
	fmt.Fprintf(&builder, "block_do_not_prompt = %t\n\n", cfg.Privacy.BlockDoNotPrompt)
	fmt.Fprintf(&builder, "[thoth]\n")
	fmt.Fprintf(&builder, "enabled = %t\n", cfg.Thoth.Enabled)
	fmt.Fprintf(&builder, "registry = %q\n\n", cfg.Thoth.Registry)
	for _, agent := range []string{"codex", "cursor", "claude_code"} {
		enabled := true
		if cfg.Agents != nil {
			if value, ok := cfg.Agents[agent]; ok {
				enabled = value.Enabled
			}
		}
		fmt.Fprintf(&builder, "[agents.%s]\n", agent)
		fmt.Fprintf(&builder, "enabled = %t\n\n", enabled)
	}
	return builder.String()
}

func applyTOML(cfg *Config, content string) error {
	section := ""
	for lineNumber, raw := range strings.Split(content, "\n") {
		line := stripComment(strings.TrimSpace(raw))
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.TrimSuffix(strings.TrimPrefix(line, "["), "]")
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return fmt.Errorf("CONFIG_INVALID: invalid config line %d", lineNumber+1)
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if err := applyValue(cfg, section, key, value); err != nil {
			return fmt.Errorf("CONFIG_INVALID: %s at line %d", err.Error(), lineNumber+1)
		}
	}
	return nil
}

func applyValue(cfg *Config, section string, key string, value string) error {
	switch section {
	case "project":
		text, err := parseString(value)
		if err != nil {
			return err
		}
		switch key {
		case "id":
			cfg.Project.ID = text
		case "name":
			cfg.Project.Name = text
		case "layer":
			cfg.Project.Layer = text
		case "author":
			cfg.Project.Author = text
		}
	case "storage":
		text, err := parseString(value)
		if err != nil {
			return err
		}
		if key == "engine" {
			cfg.Storage.Engine = text
		}
		if key == "path" {
			cfg.Storage.Path = text
		}
	case "publish":
		if key == "allowed_publish_branches" {
			items, err := parseStringArray(value)
			if err != nil {
				return err
			}
			cfg.Publish.AllowedPublishBranches = items
			return nil
		}
		text, err := parseString(value)
		if err != nil {
			return err
		}
		if key == "public_repo" {
			cfg.Publish.PublicRepo = text
		}
		if key == "target_branch" {
			cfg.Publish.TargetBranch = text
		}
	case "privacy":
		switch key {
		case "default":
			text, err := parseString(value)
			if err != nil {
				return err
			}
			cfg.Privacy.Default = text
		case "block_secret_output":
			boolValue, err := parseBool(value)
			if err != nil {
				return err
			}
			cfg.Privacy.BlockSecret = boolValue
		case "block_do_not_prompt":
			boolValue, err := parseBool(value)
			if err != nil {
				return err
			}
			cfg.Privacy.BlockDoNotPrompt = boolValue
		}
	case "thoth":
		switch key {
		case "enabled":
			boolValue, err := parseBool(value)
			if err != nil {
				return err
			}
			cfg.Thoth.Enabled = boolValue
		case "registry":
			text, err := parseString(value)
			if err != nil {
				return err
			}
			cfg.Thoth.Registry = text
		}
	default:
		if strings.HasPrefix(section, "agents.") && key == "enabled" {
			if cfg.Agents == nil {
				cfg.Agents = map[string]AgentConfig{}
			}
			boolValue, err := parseBool(value)
			if err != nil {
				return err
			}
			name := strings.TrimPrefix(section, "agents.")
			cfg.Agents[name] = AgentConfig{Enabled: boolValue}
		}
	}
	return nil
}

func stripComment(line string) string {
	inString := false
	escaped := false
	for index, char := range line {
		switch {
		case escaped:
			escaped = false
		case char == '\\':
			escaped = true
		case char == '"':
			inString = !inString
		case char == '#' && !inString:
			return strings.TrimSpace(line[:index])
		}
	}
	return strings.TrimSpace(line)
}

func parseString(value string) (string, error) {
	value = strings.TrimSpace(value)
	if len(value) < 2 || value[0] != '"' || value[len(value)-1] != '"' {
		return "", fmt.Errorf("expected quoted string")
	}
	return strings.ReplaceAll(strings.ReplaceAll(value[1:len(value)-1], `\"`, `"`), `\\`, `\`), nil
}

func parseStringArray(value string) ([]string, error) {
	value = strings.TrimSpace(value)
	if len(value) < 2 || value[0] != '[' || value[len(value)-1] != ']' {
		return nil, fmt.Errorf("expected string array")
	}
	body := strings.TrimSpace(value[1 : len(value)-1])
	if body == "" {
		return []string{}, nil
	}
	var items []string
	for _, part := range strings.Split(body, ",") {
		item, err := parseString(strings.TrimSpace(part))
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

func parseBool(value string) (bool, error) {
	switch strings.TrimSpace(value) {
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, fmt.Errorf("expected boolean")
	}
}

func quoteArray(items []string) string {
	quoted := make([]string, 0, len(items))
	for _, item := range items {
		quoted = append(quoted, fmt.Sprintf("%q", item))
	}
	return strings.Join(quoted, ", ")
}
