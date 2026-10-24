package app

import (
	"fmt"
	"io"
	"os"

	"github.com/vuthuanphat/lmti-atlas/internal/config"
	"github.com/vuthuanphat/lmti-atlas/internal/migrate"
	"github.com/vuthuanphat/lmti-atlas/internal/output"
	"github.com/vuthuanphat/lmti-atlas/pkg/contract"
)

type AdapterInspection struct {
	Status        string   `json:"status"`
	ManifestPath  string   `json:"manifestPath"`
	KnownAdapters []string `json:"knownAdapters"`
	Notes         []string `json:"notes"`
}

func runMigrate(args []string, stdout io.Writer, stderr io.Writer) int {
	if len(args) == 0 || args[0] != "from-json" {
		fmt.Fprintln(stderr, "Usage: lmti migrate from-json [--dry-run] [--path <file>] [--json]")
		return 1
	}
	jsonOutput := hasFlag(args, "--json")
	cfg, err := config.Load(".")
	if err != nil {
		return writeCommandError(stdout, stderr, jsonOutput, "lmti.migrate.from-json", contract.ErrorConfigInvalid, err.Error())
	}
	report, warnings, errors := migrate.FromJSON(ctx(), ".", cfg, migrate.FromJSONOptions{
		Path:   stringFlag(args, "--path", ""),
		DryRun: hasFlag(args, "--dry-run"),
	})
	status := statusFromMessages(warnings, errors)
	if jsonOutput {
		_ = output.WriteJSON(stdout, "lmti.migrate.from-json", status, warnings, errors, report)
		return exitForStatus(status)
	}
	if len(errors) > 0 {
		printMessages(stderr, errors)
		return exitForStatus(status)
	}
	fmt.Fprintln(stdout, "Migration from JSON")
	fmt.Fprintf(stdout, "Dry run: %t\n", report.DryRun)
	fmt.Fprintf(stdout, "Candidate files: %d\n", len(report.CandidateFiles))
	fmt.Fprintf(stdout, "Records: %d\n", report.ImportedRecords)
	if len(warnings) > 0 {
		printMessages(stdout, warnings)
	}
	return exitForStatus(status)
}

func runAdapter(args []string, stdout io.Writer, stderr io.Writer) int {
	if len(args) == 0 || args[0] != "inspect" {
		fmt.Fprintln(stderr, "Usage: lmti adapter inspect [--manifest <path>] [--json]")
		return 1
	}
	jsonOutput := hasFlag(args, "--json")
	manifest := stringFlag(args, "--manifest", ".lmti/adapter.toml")
	inspection := AdapterInspection{
		Status:        "warn",
		ManifestPath:  manifest,
		KnownAdapters: []string{"codex", "cursor", "claude_code"},
		Notes: []string{
			"Adapters must use CLI/API contracts and must not read SQLite directly.",
			"Unknown permissions are denied by default.",
		},
	}
	var warnings []contract.BoundaryMessage
	if _, err := os.Stat(manifest); err != nil {
		warnings = append(warnings, contract.BoundaryMessage{Code: contract.ErrorAdapterNotFound, Message: "Adapter manifest was not found; using built-in local-alpha adapter assumptions."})
	} else {
		inspection.Status = "pass"
	}
	status := statusFromMessages(warnings, nil)
	if jsonOutput {
		_ = output.WriteJSON(stdout, "lmti.adapter.inspect", status, warnings, nil, inspection)
		return exitForStatus(status)
	}
	fmt.Fprintln(stdout, "Adapter inspect")
	fmt.Fprintf(stdout, "Manifest: %s\n", inspection.ManifestPath)
	fmt.Fprintf(stdout, "Status: %s\n", inspection.Status)
	for _, note := range inspection.Notes {
		fmt.Fprintf(stdout, "- %s\n", note)
	}
	return exitForStatus(status)
}

