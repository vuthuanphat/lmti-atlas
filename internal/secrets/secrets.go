// Package secrets implements conservative, local secret and protected-path checks.
// These heuristics supplement privacy policy; they do not prove content is safe.
package secrets

import (
	"path"
	"regexp"
	"strings"
)

var markers = []*regexp.Regexp{
	regexp.MustCompile(`(?i)-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----`),
	regexp.MustCompile(`\b(?:sk-(?:proj-|ant-)?|gh[pousr]_)[A-Za-z0-9_-]{20,}\b`),
	regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`),
	regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`),
	regexp.MustCompile(`(?i)\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis)://[^\s"']+`),
}
var assignment = regexp.MustCompile(`(?i)\b(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key)\b["']?\s*[:=]\s*["']?([^\s"']{8,})`)

func ContainsSecretLikeContent(content string) bool {
	for _, marker := range markers {
		if marker.MatchString(content) {
			return true
		}
	}
	for _, match := range assignment.FindAllStringSubmatch(content, -1) {
		value := strings.ToLower(match[1])
		if strings.HasPrefix(value, "env:") || strings.HasPrefix(value, "${") || strings.HasPrefix(value, "<") || value == "[redacted]" {
			continue
		}
		return true
	}
	return false
}

func IsProtectedPath(value string) bool {
	p := strings.ToLower(strings.ReplaceAll(value, "\\", "/"))
	if strings.ContainsRune(p, 0) {
		return true
	}
	for _, segment := range strings.Split(p, "/") {
		if segment == ".." {
			return true
		}
	}
	p = strings.TrimPrefix(path.Clean(p), "./")
	// This source module is deliberately public; similarly named data is not.
	if p == "internal/secrets/secrets.go" || p == "internal/secrets/secrets_test.go" {
		return false
	}
	if p == ".lmti/readme.md" || p == ".lmti/agent_boundary.md" || p == ".lmti/layer.json" {
		return false
	}
	for _, segment := range strings.Split(p, "/") {
		if segment == ".env" || strings.HasPrefix(segment, ".env.") || segment == "secrets" || segment == "credentials" || segment == ".aws" || segment == ".codex" || segment == ".agents" || segment == ".lmti" {
			return true
		}
	}
	for _, ext := range []string{".pem", ".key", ".p12", ".pfx", ".crt", ".cer", ".token", ".sqlite", ".sqlite3", ".sqlite-wal", ".sqlite-shm", ".sqlite-journal", ".db", ".log"} {
		if strings.HasSuffix(p, ext) {
			return true
		}
	}
	return false
}
