package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/vuthuanphat/lmti-atlas/pkg/contract"
)

const DefaultPath = ".lmti/memory.sqlite"
const SchemaPath = "internal/storage/schema.sql"
const bridgePath = "internal/storage/sqlite_bridge.js"

type SQLiteConfig struct {
	Path string
}

type Store struct {
	Config SQLiteConfig
}

func NewSQLiteStore(path string) Store {
	if path == "" {
		path = DefaultPath
	}
	return Store{Config: SQLiteConfig{Path: path}}
}

type Stats struct {
	TotalMemoryRecords int                   `json:"totalMemoryRecords"`
	ByPrivacy          []PrivacyCount        `json:"byPrivacy"`
	Migrations         []SchemaMigrationState `json:"migrations"`
}

type PrivacyCount struct {
	Privacy string `json:"privacy"`
	Count   int    `json:"count"`
}

type SchemaMigrationState struct {
	Version   int    `json:"version"`
	Name      string `json:"name"`
	AppliedAt string `json:"applied_at"`
}

type SearchOptions struct {
	Query      string
	PrivacyMax contract.PrivacyLevel
	Limit      int
}

type BridgeResponse struct {
	OK      bool                    `json:"ok"`
	ID      string                  `json:"id,omitempty"`
	Records []contract.MemoryRecord `json:"records,omitempty"`
	Stats   Stats                   `json:"stats,omitempty"`
}

func (store Store) Ensure(ctx context.Context, root string) error {
	_, err := store.runBridge(ctx, root, map[string]any{"op": "migrate"})
	return err
}

func (store Store) InsertMemory(ctx context.Context, root string, record contract.MemoryRecord) error {
	if record.ID == "" {
		record.ID = newID("mem")
	}
	if record.SchemaVersion == "" {
		record.SchemaVersion = "lmti.memory.v1"
	}
	if record.CreatedAt.IsZero() {
		record.CreatedAt = time.Now().UTC()
	}
	if record.UpdatedAt.IsZero() {
		record.UpdatedAt = record.CreatedAt
	}
	if record.ContentHash == "" {
		hash := sha256.Sum256([]byte(record.Content))
		record.ContentHash = hex.EncodeToString(hash[:])
	}
	_, err := store.runBridge(ctx, root, map[string]any{"op": "insertMemory", "record": record})
	return err
}

func (store Store) SearchMemory(ctx context.Context, root string, options SearchOptions) ([]contract.MemoryRecord, error) {
	if options.Limit <= 0 {
		options.Limit = 8
	}
	if options.PrivacyMax == "" {
		options.PrivacyMax = contract.PrivacyInternal
	}
	response, err := store.runBridge(ctx, root, map[string]any{
		"op":         "searchMemory",
		"query":      options.Query,
		"privacyMax": string(options.PrivacyMax),
		"limit":      options.Limit,
	})
	if err != nil {
		return nil, err
	}
	return response.Records, nil
}

func (store Store) Stats(ctx context.Context, root string) (Stats, error) {
	response, err := store.runBridge(ctx, root, map[string]any{"op": "stats"})
	if err != nil {
		return Stats{}, err
	}
	return response.Stats, nil
}

func (store Store) runBridge(ctx context.Context, root string, payload map[string]any) (BridgeResponse, error) {
	schema, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(SchemaPath)))
	if err != nil {
		return BridgeResponse{}, fmt.Errorf("%s: schema file unavailable: %w", contract.ErrorStorageUnavailable, err)
	}
	bridge := filepath.Join(root, filepath.FromSlash(bridgePath))
	if _, err := os.Stat(bridge); err != nil {
		return BridgeResponse{}, fmt.Errorf("%s: sqlite bridge unavailable: %w", contract.ErrorStorageUnavailable, err)
	}
	dbPath := store.Config.Path
	if dbPath == "" {
		dbPath = DefaultPath
	}
	if !filepath.IsAbs(dbPath) {
		dbPath = filepath.ToSlash(filepath.Clean(filepath.FromSlash(dbPath)))
	}
	payload["dbPath"] = dbPath
	payload["schema"] = string(schema)
	body, err := json.Marshal(payload)
	if err != nil {
		return BridgeResponse{}, err
	}
	cmd := exec.CommandContext(ctx, "node", bridge)
	cmd.Dir = root
	cmd.Stdin = bytes.NewReader(body)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return BridgeResponse{}, fmt.Errorf("%s: %s", contract.ErrorStorageUnavailable, message)
	}
	var response BridgeResponse
	if err := json.Unmarshal(stdout.Bytes(), &response); err != nil {
		return BridgeResponse{}, fmt.Errorf("%s: invalid sqlite bridge response: %w", contract.ErrorStorageUnavailable, err)
	}
	if !response.OK {
		return BridgeResponse{}, errors.New(string(contract.ErrorStorageUnavailable))
	}
	return response, nil
}

func newID(prefix string) string {
	now := time.Now().UTC().Format("20060102150405.000000000")
	clean := strings.NewReplacer(".", "", "-", "", ":", "").Replace(now)
	return prefix + "_" + clean
}
