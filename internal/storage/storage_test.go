package storage

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/vuthuanphat/lmti-atlas/pkg/contract"
)

func TestSQLiteBridgeInsertSearchStats(t *testing.T) {
	if err := exec.Command("node", "-e", "require('node:sqlite')").Run(); err != nil {
		t.Skip("node:sqlite is not available")
	}
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "internal", "storage"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	schema, err := os.ReadFile("schema.sql")
	if err != nil {
		t.Fatalf("read schema: %v", err)
	}
	bridge, err := os.ReadFile("sqlite_bridge.js")
	if err != nil {
		t.Fatalf("read bridge: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(SchemaPath)), schema, 0o600); err != nil {
		t.Fatalf("write schema: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(bridgePath)), bridge, 0o600); err != nil {
		t.Fatalf("write bridge: %v", err)
	}
	store := NewSQLiteStore(".lmti/memory.sqlite")
	if err := store.Ensure(context.Background(), root); err != nil {
		t.Fatalf("Ensure returned error: %v", err)
	}
	now := time.Now().UTC()
	record := contract.MemoryRecord{
		ID:            "mem_test",
		SchemaVersion: "lmti.memory.v1",
		ProjectID:     "lmti-atlas",
		Kind:          "note",
		Title:         "Deploy note",
		Content:       "Use publish preflight before release.",
		Privacy:       contract.PrivacyInternal,
		Confidence:    0.8,
		Importance:    0.9,
		SourceAgent:   "test",
		Tags:          []string{"deploy"},
		RelatedFiles:  []string{},
		CreatedAt:     now,
		UpdatedAt:     now,
		Metadata:      map[string]string{},
		ContentHash:   "hash",
	}
	if err := store.InsertMemory(context.Background(), root, record); err != nil {
		t.Fatalf("InsertMemory returned error: %v", err)
	}
	records, err := store.SearchMemory(context.Background(), root, SearchOptions{Query: "publish", PrivacyMax: contract.PrivacyInternal})
	if err != nil {
		t.Fatalf("SearchMemory returned error: %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("records %d", len(records))
	}
	stats, err := store.Stats(context.Background(), root)
	if err != nil {
		t.Fatalf("Stats returned error: %v", err)
	}
	if stats.TotalMemoryRecords != 1 {
		t.Fatalf("stats records %d", stats.TotalMemoryRecords)
	}
}

