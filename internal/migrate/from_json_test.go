package migrate

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuthuanphat/lmti-atlas/internal/config"
	"github.com/vuthuanphat/lmti-atlas/pkg/contract"
)

func TestParseLegacyMemoryPreservesUnknownMetadata(t *testing.T) {
	cfg := config.Default()
	records, err := parseLegacyMemory([]byte(`[{"id":"old1","title":"Rule","content":"Use safe context.","privacy":"internal","legacy_score":7}]`), cfg)
	if err != nil {
		t.Fatalf("parseLegacyMemory returned error: %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("records %d", len(records))
	}
	if records[0].Metadata["legacy_score"] != "7" {
		t.Fatalf("metadata was not preserved: %#v", records[0].Metadata)
	}
}

func TestFromJSONDryRunBlocksSecretLikeFile(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".lmti"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, ".lmti", "memory.json"), []byte(`{"title":"Bad","api_key":"abcdefghijklmnopqrstuvwxyz123456"}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	report, warnings, errors := FromJSON(context.Background(), root, config.Default(), FromJSONOptions{DryRun: true})
	if len(errors) > 0 {
		t.Fatalf("unexpected errors: %#v", errors)
	}
	if len(warnings) == 0 || warnings[0].Code != contract.ErrorSecretDetected {
		t.Fatalf("expected secret warning, got %#v", warnings)
	}
	if len(report.BlockedFiles) != 1 {
		t.Fatalf("blocked files %#v", report.BlockedFiles)
	}
}

func TestFromJSONWriteGuardPreservesPolicySourceAndTarget(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, ".lmti")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(dir, "memory.json")
	legacy := []byte(`[{"title":"Ordinary fixture","content":"Ordinary text","sensitivity":"secret","promptPolicy":"do_not_prompt","sourceRefs":["fixture.md:1"]}]`)
	if err := os.WriteFile(source, legacy, 0o600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dir, "memory.sqlite")
	before := []byte("existing target fixture; must not be opened")
	if err := os.WriteFile(target, before, 0o600); err != nil {
		t.Fatal(err)
	}
	report, _, errors := FromJSON(context.Background(), root, config.Default(), FromJSONOptions{})
	if report.ImportedRecords != 0 || len(errors) != 1 || !strings.Contains(errors[0].Message, "LEGACY_MEMORY_MIGRATION_BLOCKED") {
		t.Fatalf("unsafe migration was not blocked: %#v", errors)
	}
	for file, expected := range map[string][]byte{source: legacy, target: before} {
		actual, err := os.ReadFile(file)
		if err != nil || !bytes.Equal(actual, expected) {
			t.Fatal("migration changed source or target")
		}
	}
}
