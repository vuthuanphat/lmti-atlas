package migrate

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/vuthuanphat/lmti-atlas/internal/config"
	"github.com/vuthuanphat/lmti-atlas/internal/credentialscan"
	"github.com/vuthuanphat/lmti-atlas/pkg/contract"
)

type FromJSONOptions struct {
	Path   string
	DryRun bool
}

type FromJSONReport struct {
	DryRun          bool     `json:"dryRun"`
	CandidateFiles  []string `json:"candidateFiles"`
	ImportedRecords int      `json:"importedRecords"`
	BlockedFiles    []string `json:"blockedFiles"`
	SkippedFiles    []string `json:"skippedFiles"`
}

func FromJSON(ctx context.Context, root string, cfg config.Config, options FromJSONOptions) (FromJSONReport, []contract.BoundaryMessage, []contract.BoundaryMessage) {
	report := FromJSONReport{DryRun: options.DryRun}
	// The generic mapper cannot preserve TS sensitivity/prompt policy, project
	// scope, provenance and lesson lifecycle. Keep this experimental surface as
	// inventory only until a lossless migration contract is verified.
	if !options.DryRun {
		return report, nil, []contract.BoundaryMessage{{Code: contract.ErrorMigrationRequired, Message: "LEGACY_MEMORY_MIGRATION_BLOCKED: lossless policy, provenance and lifecycle mapping is required; use --dry-run and keep the original stores."}}
	}
	candidates, err := findCandidates(root, options.Path)
	if err != nil {
		return report, nil, []contract.BoundaryMessage{{Code: contract.ErrorMigrationRequired, Message: err.Error()}}
	}
	report.CandidateFiles = candidates
	for _, candidate := range candidates {
		content, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(candidate)))
		if err != nil {
			report.SkippedFiles = append(report.SkippedFiles, candidate)
			continue
		}
		if credentialscan.ContainsSecretLikeContent(string(content)) {
			report.BlockedFiles = append(report.BlockedFiles, candidate)
			continue
		}
		records, err := parseLegacyMemory(content, cfg)
		if err != nil {
			report.SkippedFiles = append(report.SkippedFiles, candidate)
			continue
		}
		// Retain the historical report field for compatibility: in dry-run this
		// counts candidates, never persisted records.
		report.ImportedRecords += len(records)
	}
	var warnings []contract.BoundaryMessage
	if len(report.BlockedFiles) > 0 {
		warnings = append(warnings, contract.BoundaryMessage{Code: contract.ErrorSecretDetected, Message: "One or more legacy JSON files were blocked because they contain secret-like content."})
	}
	return report, warnings, nil
}

func findCandidates(root string, explicit string) ([]string, error) {
	if explicit != "" {
		clean := filepath.Clean(filepath.FromSlash(explicit))
		if filepath.IsAbs(clean) || strings.HasPrefix(clean, "..") {
			return nil, fmt.Errorf("migration path must stay inside the project root")
		}
		return []string{filepath.ToSlash(clean)}, nil
	}
	var candidates []string
	for _, base := range []string{".lmti", ".atlas"} {
		start := filepath.Join(root, base)
		if _, err := os.Stat(start); err != nil {
			continue
		}
		_ = filepath.WalkDir(start, func(path string, entry fs.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return nil
			}
			name := strings.ToLower(entry.Name())
			if !strings.HasSuffix(name, ".json") {
				return nil
			}
			if name == "project.amf.json" || name == "index.json" || name == "config.json" || name == "layer.json" {
				return nil
			}
			if strings.Contains(name, "memory") || strings.Contains(name, "lesson") || strings.Contains(name, "event") {
				rel, relErr := filepath.Rel(root, path)
				if relErr == nil {
					candidates = append(candidates, filepath.ToSlash(rel))
				}
			}
			return nil
		})
	}
	return candidates, nil
}

func parseLegacyMemory(content []byte, cfg config.Config) ([]contract.MemoryRecord, error) {
	var raw any
	if err := json.Unmarshal(content, &raw); err != nil {
		return nil, err
	}
	items := []any{}
	switch value := raw.(type) {
	case []any:
		items = value
	case map[string]any:
		if nested, ok := value["records"].([]any); ok {
			items = nested
		} else if nested, ok := value["memories"].([]any); ok {
			items = nested
		} else {
			items = []any{value}
		}
	default:
		return nil, fmt.Errorf("unsupported legacy memory JSON shape")
	}
	records := make([]contract.MemoryRecord, 0, len(items))
	for _, item := range items {
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		record := legacyObjectToRecord(object, cfg)
		if record.Title != "" && record.Content != "" {
			records = append(records, record)
		}
	}
	return records, nil
}

func legacyObjectToRecord(object map[string]any, cfg config.Config) contract.MemoryRecord {
	now := time.Now().UTC()
	privacy := contract.PrivacyLevel(stringValue(object, "privacy", cfg.Privacy.Default))
	if privacy == "" {
		privacy = contract.PrivacyInternal
	}
	metadata := map[string]string{}
	known := map[string]bool{"id": true, "schema_version": true, "schemaVersion": true, "project_id": true, "projectID": true, "kind": true, "title": true, "content": true, "summary": true, "privacy": true, "tags": true}
	for key, value := range object {
		if !known[key] {
			metadata[key] = fmt.Sprint(value)
		}
	}
	return contract.MemoryRecord{
		ID:            stringValue(object, "id", ""),
		SchemaVersion: stringValue(object, "schema_version", "lmti.memory.v1"),
		ProjectID:     stringValue(object, "project_id", cfg.Project.ID),
		Kind:          stringValue(object, "kind", "legacy"),
		Title:         stringValue(object, "title", ""),
		Content:       stringValue(object, "content", stringValue(object, "summary", "")),
		Privacy:       privacy,
		Confidence:    0.6,
		Importance:    0.4,
		SourceAgent:   "json-migration",
		Tags:          stringArrayValue(object, "tags"),
		RelatedFiles:  stringArrayValue(object, "related_files"),
		CreatedAt:     now,
		UpdatedAt:     now,
		Metadata:      metadata,
	}
}

func stringValue(object map[string]any, key string, fallback string) string {
	if value, ok := object[key]; ok {
		if text, ok := value.(string); ok {
			return text
		}
	}
	return fallback
}

func stringArrayValue(object map[string]any, key string) []string {
	value, ok := object[key]
	if !ok {
		return []string{}
	}
	rawItems, ok := value.([]any)
	if !ok {
		return []string{}
	}
	var items []string
	for _, raw := range rawItems {
		if item, ok := raw.(string); ok {
			items = append(items, item)
		}
	}
	return items
}
