package memory

import (
	"context"
	"testing"

	"github.com/vuthuanphat/lmti-atlas/internal/config"
	"github.com/vuthuanphat/lmti-atlas/pkg/contract"
)

func TestAddBlocksSecretLikeContentBeforeStorage(t *testing.T) {
	cfg := config.Default()
	_, _, errors := Add(context.Background(), t.TempDir(), cfg, AddRequest{
		Title:   "Blocked",
		Content: "api_" + "key = \"abcdefghijklmnopqrstuvwxyz123456\"",
		Privacy: contract.PrivacyInternal,
	})
	if len(errors) == 0 {
		t.Fatal("expected secret-like content to be blocked")
	}
	if errors[0].Code != contract.ErrorSecretDetected {
		t.Fatalf("error code %s", errors[0].Code)
	}
}

func TestSearchBlocksSecretPrivacyMax(t *testing.T) {
	cfg := config.Default()
	_, _, errors := Search(context.Background(), t.TempDir(), cfg, "deploy", contract.PrivacySecret, 8)
	if len(errors) == 0 {
		t.Fatal("expected secret privacy retrieval to be blocked")
	}
	if errors[0].Code != contract.ErrorPrivacyBlocked {
		t.Fatalf("error code %s", errors[0].Code)
	}
}
