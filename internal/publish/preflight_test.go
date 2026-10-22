package publish

import (
	"testing"
)

func TestBranchAllowed(t *testing.T) {
	allowed := []string{"main", "release/*", "publish/*"}
	for _, branch := range []string{"main", "release/v1", "publish/draft"} {
		if !branchAllowed(branch, allowed) {
			t.Fatalf("%s should be allowed", branch)
		}
	}
	if branchAllowed("feature/random", allowed) {
		t.Fatal("feature/random should not be allowed")
	}
}

func TestNormalizeRemote(t *testing.T) {
	got := normalizeRemote("git@github.com:vuthuanphat/lmti-atlas.git")
	want := "https://github.com/vuthuanphat/lmti-atlas"
	if got != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

