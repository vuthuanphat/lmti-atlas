package memory

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/vuthuanphat/lmti-atlas/internal/config"
	"github.com/vuthuanphat/lmti-atlas/internal/credentialscan"
	"github.com/vuthuanphat/lmti-atlas/internal/storage"
	"github.com/vuthuanphat/lmti-atlas/pkg/contract"
)

type AddRequest struct {
	Kind         string
	Title        string
	Content      string
	Privacy      contract.PrivacyLevel
	SourceAgent  string
	Tags         []string
	RelatedFiles []string
	Metadata     map[string]string
}

type AddResult struct {
	Record contract.MemoryRecord `json:"record"`
}

type SearchResult struct {
	Query      string                  `json:"query"`
	PrivacyMax contract.PrivacyLevel   `json:"privacyMax"`
	Records    []contract.MemoryRecord `json:"records"`
}

func Add(ctx context.Context, root string, cfg config.Config, request AddRequest) (AddResult, []contract.BoundaryMessage, []contract.BoundaryMessage) {
	if strings.TrimSpace(request.Title) == "" || strings.TrimSpace(request.Content) == "" {
		return AddResult{}, nil, []contract.BoundaryMessage{{Code: contract.ErrorConfigInvalid, Message: "Memory title and content are required."}}
	}
	if credentialscan.ContainsSecretLikeContent(request.Content) {
		return AddResult{}, nil, []contract.BoundaryMessage{{Code: contract.ErrorSecretDetected, Message: "Secret-like memory content was blocked and not stored."}}
	}
	privacy := request.Privacy
	if privacy == "" {
		privacy = contract.PrivacyLevel(cfg.Privacy.Default)
	}
	if privacy == contract.PrivacySecret || privacy == contract.PrivacyDoNotPrompt {
		return AddResult{}, nil, []contract.BoundaryMessage{{Code: contract.ErrorPrivacyBlocked, Message: "Secret and do_not_prompt memory cannot be stored through this command."}}
	}
	now := time.Now().UTC()
	hash := sha256.Sum256([]byte(request.Content))
	record := contract.MemoryRecord{
		ID:            "mem_" + strings.NewReplacer(".", "", "-", "", ":", "").Replace(now.Format("20060102150405.000000000")),
		SchemaVersion: "lmti.memory.v1",
		ProjectID:     cfg.Project.ID,
		Kind:          defaultString(request.Kind, "note"),
		Title:         request.Title,
		Content:       request.Content,
		Privacy:       privacy,
		Confidence:    0.8,
		Importance:    0.5,
		SourceAgent:   defaultString(request.SourceAgent, "lmti-cli"),
		Tags:          request.Tags,
		RelatedFiles:  request.RelatedFiles,
		CreatedAt:     now,
		UpdatedAt:     now,
		Metadata:      request.Metadata,
		ContentHash:   hex.EncodeToString(hash[:]),
	}
	store := storage.NewSQLiteStore(cfg.Storage.Path)
	if err := store.InsertMemory(ctx, root, record); err != nil {
		return AddResult{}, nil, []contract.BoundaryMessage{{Code: contract.ErrorStorageUnavailable, Message: err.Error()}}
	}
	return AddResult{Record: record}, nil, nil
}

func Search(ctx context.Context, root string, cfg config.Config, query string, privacyMax contract.PrivacyLevel, limit int) (SearchResult, []contract.BoundaryMessage, []contract.BoundaryMessage) {
	if strings.TrimSpace(query) == "" {
		return SearchResult{}, nil, []contract.BoundaryMessage{{Code: contract.ErrorConfigInvalid, Message: "Search query is required."}}
	}
	if privacyMax == "" {
		privacyMax = contract.PrivacyInternal
	}
	if privacyMax == contract.PrivacySecret || privacyMax == contract.PrivacyDoNotPrompt {
		return SearchResult{}, nil, []contract.BoundaryMessage{{Code: contract.ErrorPrivacyBlocked, Message: "secret and do_not_prompt memory cannot be retrieved for agent context."}}
	}
	store := storage.NewSQLiteStore(cfg.Storage.Path)
	records, err := store.SearchMemory(ctx, root, storage.SearchOptions{Query: query, PrivacyMax: privacyMax, Limit: limit})
	if err != nil {
		return SearchResult{}, nil, []contract.BoundaryMessage{{Code: contract.ErrorStorageUnavailable, Message: err.Error()}}
	}
	return SearchResult{Query: query, PrivacyMax: privacyMax, Records: records}, nil, nil
}

func Stats(ctx context.Context, root string, cfg config.Config) (storage.Stats, []contract.BoundaryMessage, []contract.BoundaryMessage) {
	store := storage.NewSQLiteStore(cfg.Storage.Path)
	stats, err := store.Stats(ctx, root)
	if err != nil {
		return storage.Stats{}, nil, []contract.BoundaryMessage{{Code: contract.ErrorStorageUnavailable, Message: err.Error()}}
	}
	return stats, nil, nil
}

func ParsePrivacy(value string) (contract.PrivacyLevel, error) {
	switch contract.PrivacyLevel(strings.TrimSpace(value)) {
	case "", contract.PrivacyPublic, contract.PrivacyInternal, contract.PrivacyPrivate, contract.PrivacySecret, contract.PrivacyDoNotPrompt:
		return contract.PrivacyLevel(strings.TrimSpace(value)), nil
	default:
		return "", fmt.Errorf("invalid privacy level: %s", value)
	}
}

func defaultString(value string, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
