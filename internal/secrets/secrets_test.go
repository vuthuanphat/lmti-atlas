package secrets

import "testing"

func TestSecretChecks(t *testing.T) {
	for _, value := range []string{"api_key = \"" + "fake-value-for-test-only" + "\"", "-----BEGIN PRIVATE KEY-----", "postgres://example.invalid/db"} {
		if !ContainsSecretLikeContent(value) {
			t.Fatal("secret-like input accepted")
		}
	}
	for _, value := range []string{"Use environment variables for API keys", "api_key = env:LMTI_TEST_KEY", "token = ${LMTI_TEST_TOKEN}", "password = <placeholder>"} {
		if ContainsSecretLikeContent(value) {
			t.Fatal("reference or ordinary documentation blocked")
		}
	}
}

func TestProtectedPaths(t *testing.T) {
	for _, value := range []string{".env", "service/.env.local", `service\credentials\local.txt`, "internal/secrets/data.json", "internal/secrets/.env.go", "../src/file.go", ".lmti/memory.sqlite", "topology.sqlite-wal", ".aws/config"} {
		if !IsProtectedPath(value) {
			t.Fatalf("protected path accepted: %s", value)
		}
	}
	for _, value := range []string{"internal/secrets/secrets.go", "internal/secrets/secrets_test.go", "src/app.go", ".lmti/README.md"} {
		if IsProtectedPath(value) {
			t.Fatalf("public source blocked: %s", value)
		}
	}
}
